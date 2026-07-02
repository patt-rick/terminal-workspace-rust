//! Web Push: notifications delivered to the phone even when the PWA is fully
//! closed, via the browser's push service (FCM / Mozilla autopush / APNs web).
//!
//! Implemented directly on `ring` (already in the dependency tree) because the
//! dev network can't fetch new crates:
//! - VAPID (RFC 8292): an ES256 JWT proves the sender to the push service.
//! - Message encryption (RFC 8291, `aes128gcm`): ECDH(P-256) + HKDF-SHA256 +
//!   AES-128-GCM against the subscription's `p256dh`/`auth` keys.
//!
//! State model matches the rest of remote access: the VAPID keypair and the
//! single subscription (one active session → one subscription slot) live in
//! memory only. Pushes are only sent while no WebSocket client is connected —
//! a live client shows notifications through its own service worker.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use parking_lot::Mutex;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use ring::{aead, agreement, hkdf};
use serde::Deserialize;
use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A "finished" push is only sent for tasks that ran at least this long —
/// otherwise every shell prompt would notify.
const MIN_WORKING_FOR_PUSH: Duration = Duration::from_secs(15);
/// How long the push service should retain an undelivered message.
const PUSH_TTL_SECS: u32 = 3600;

#[derive(Debug, Clone, Deserialize)]
pub struct PushSubscription {
    pub endpoint: String,
    /// Browser's P-256 public key, base64url.
    pub p256dh: String,
    /// 16-byte auth secret, base64url.
    pub auth: String,
}

/// Holds the VAPID keypair, the (single) subscription, and the working-since
/// tracking used to suppress trivial "finished" pushes.
pub struct PushManager {
    rng: SystemRandom,
    /// PKCS#8 of the VAPID signing key (regenerated per app launch; the client
    /// reconciles by re-subscribing when the advertised key changes).
    vapid_pkcs8: Vec<u8>,
    vapid_public_b64: String,
    subscription: Mutex<Option<PushSubscription>>,
    working_since: Mutex<HashMap<String, Instant>>,
    /// Per-terminal last-push time — hook events and title heuristics can both
    /// fire for the same moment; one notification is enough.
    last_push: Mutex<HashMap<String, Instant>>,
    http: reqwest::Client,
}

impl PushManager {
    pub fn new() -> Option<Self> {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).ok()?;
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .ok()?;
        let public = URL_SAFE_NO_PAD.encode(key.public_key().as_ref());
        Some(Self {
            rng,
            vapid_pkcs8: pkcs8.as_ref().to_vec(),
            vapid_public_b64: public,
            subscription: Mutex::new(None),
            working_since: Mutex::new(HashMap::new()),
            last_push: Mutex::new(HashMap::new()),
            http: reqwest::Client::new(),
        })
    }

    /// The `applicationServerKey` the browser subscribes with (b64url, 65-byte
    /// uncompressed P-256 point).
    pub fn vapid_public_key(&self) -> String {
        self.vapid_public_b64.clone()
    }

    pub fn set_subscription(&self, sub: PushSubscription) {
        *self.subscription.lock() = Some(sub);
    }

    pub fn clear_subscription(&self) {
        *self.subscription.lock() = None;
        self.working_since.lock().clear();
    }

    pub fn has_subscription(&self) -> bool {
        self.subscription.lock().is_some()
    }

    /// Debounce pushes per terminal: true = go ahead (and records the time),
    /// false = a push for this terminal fired within the last 5s, skip.
    pub fn allow_push(&self, terminal_id: &str) -> bool {
        let mut map = self.last_push.lock();
        let now = Instant::now();
        if map
            .get(terminal_id)
            .is_some_and(|t| now.duration_since(*t) < Duration::from_secs(5))
        {
            return false;
        }
        map.insert(terminal_id.to_string(), now);
        true
    }

    /// Track a working-state transition; returns true if a `working=false`
    /// transition represents a task long enough to be push-worthy.
    pub fn note_working(&self, terminal_id: &str, working: bool) -> bool {
        let mut map = self.working_since.lock();
        if working {
            map.entry(terminal_id.to_string()).or_insert_with(Instant::now);
            false
        } else {
            map.remove(terminal_id)
                .is_some_and(|start| start.elapsed() >= MIN_WORKING_FOR_PUSH)
        }
    }

    /// Encrypt and POST a notification. Returns Err with a short reason (the
    /// caller logs; push is best-effort by design).
    pub async fn send(&self, title: &str, body: &str) -> Result<(), String> {
        let Some(sub) = self.subscription.lock().clone() else {
            return Err("no subscription".into());
        };
        let payload = serde_json::json!({ "title": title, "body": body }).to_string();

        let ua_public = URL_SAFE_NO_PAD
            .decode(sub.p256dh.trim_end_matches('='))
            .map_err(|_| "bad p256dh".to_string())?;
        let auth_secret = URL_SAFE_NO_PAD
            .decode(sub.auth.trim_end_matches('='))
            .map_err(|_| "bad auth".to_string())?;

        let encrypted = encrypt_aes128gcm(&self.rng, &ua_public, &auth_secret, payload.as_bytes())?;
        let auth_header = self.vapid_header(&sub.endpoint)?;

        let resp = self
            .http
            .post(&sub.endpoint)
            .header("authorization", auth_header)
            .header("content-encoding", "aes128gcm")
            .header("content-type", "application/octet-stream")
            .header("ttl", PUSH_TTL_SECS.to_string())
            .header("urgency", "high")
            .body(encrypted)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("push POST failed: {e}"))?;

        if resp.status() == reqwest::StatusCode::GONE
            || resp.status() == reqwest::StatusCode::NOT_FOUND
        {
            // Subscription expired/revoked — drop it so we stop trying.
            *self.subscription.lock() = None;
            return Err("subscription expired".into());
        }
        if !resp.status().is_success() {
            return Err(format!("push service returned {}", resp.status()));
        }
        Ok(())
    }

    /// `Authorization: vapid t=<ES256 JWT>, k=<public key>` (RFC 8292).
    fn vapid_header(&self, endpoint: &str) -> Result<String, String> {
        let url = reqwest::Url::parse(endpoint).map_err(|_| "bad endpoint".to_string())?;
        let aud = format!(
            "{}://{}",
            url.scheme(),
            url.host_str().ok_or_else(|| "bad endpoint host".to_string())?
        );
        let exp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "clock error".to_string())?
            .as_secs()
            + 12 * 3600;

        let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = URL_SAFE_NO_PAD.encode(
            serde_json::json!({
                "aud": aud,
                "exp": exp,
                "sub": "mailto:remote@terminal-workspace.local",
            })
            .to_string(),
        );
        let signing_input = format!("{header}.{claims}");

        let key = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &self.vapid_pkcs8,
            &self.rng,
        )
        .map_err(|_| "vapid key error".to_string())?;
        let sig = key
            .sign(&self.rng, signing_input.as_bytes())
            .map_err(|_| "vapid sign error".to_string())?;
        let jwt = format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref()));
        Ok(format!("vapid t={jwt}, k={}", self.vapid_public_b64))
    }
}

/// HKDF output length helper for ring.
struct OkmLen(usize);
impl hkdf::KeyType for OkmLen {
    fn len(&self) -> usize {
        self.0
    }
}

fn hkdf_expand(prk: &hkdf::Prk, info: &[&[u8]], len: usize) -> Result<Vec<u8>, String> {
    let okm = prk
        .expand(info, OkmLen(len))
        .map_err(|_| "hkdf expand failed".to_string())?;
    let mut out = vec![0u8; len];
    okm.fill(&mut out).map_err(|_| "hkdf fill failed".to_string())?;
    Ok(out)
}

/// RFC 8291 `aes128gcm` encryption of a single record.
fn encrypt_aes128gcm(
    rng: &SystemRandom,
    ua_public: &[u8],
    auth_secret: &[u8],
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    // Ephemeral application-server ECDH keypair.
    let as_private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, rng)
        .map_err(|_| "ecdh keygen failed".to_string())?;
    let as_public = as_private
        .compute_public_key()
        .map_err(|_| "ecdh pubkey failed".to_string())?;
    let as_public_bytes = as_public.as_ref().to_vec();

    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, ua_public);
    let shared = agreement::agree_ephemeral(as_private, &peer, |secret| secret.to_vec())
        .map_err(|_| "ecdh agreement failed (bad p256dh?)".to_string())?;

    let mut salt = [0u8; 16];
    ring::rand::SecureRandom::fill(rng, &mut salt).map_err(|_| "rng failed".to_string())?;

    let (cek, nonce) = derive_cek_nonce(&shared, auth_secret, ua_public, &as_public_bytes, &salt)?;
    seal_record(&cek, &nonce, payload, &salt, &as_public_bytes)
}

/// The HKDF chain from the ECDH shared secret to the content key + nonce
/// (split out so tests can drive it with a fixed secret).
fn derive_cek_nonce(
    ecdh_secret: &[u8],
    auth_secret: &[u8],
    ua_public: &[u8],
    as_public: &[u8],
    salt: &[u8; 16],
) -> Result<(Vec<u8>, Vec<u8>), String> {
    // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info"||0x00||ua_pub||as_pub, 32)
    let prk_key = hkdf::Salt::new(hkdf::HKDF_SHA256, auth_secret).extract(ecdh_secret);
    let ikm = hkdf_expand(
        &prk_key,
        &[b"WebPush: info\x00", ua_public, as_public],
        32,
    )?;
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(&ikm);
    let cek = hkdf_expand(&prk, &[b"Content-Encoding: aes128gcm\x00"], 16)?;
    let nonce = hkdf_expand(&prk, &[b"Content-Encoding: nonce\x00"], 12)?;
    Ok((cek, nonce))
}

/// Assemble the aes128gcm body: header || AES-128-GCM(payload || 0x02).
fn seal_record(
    cek: &[u8],
    nonce: &[u8],
    payload: &[u8],
    salt: &[u8; 16],
    as_public: &[u8],
) -> Result<Vec<u8>, String> {
    let key = aead::UnboundKey::new(&aead::AES_128_GCM, cek)
        .map_err(|_| "bad content key".to_string())?;
    let key = aead::LessSafeKey::new(key);
    let nonce = aead::Nonce::try_assume_unique_for_key(nonce)
        .map_err(|_| "bad nonce".to_string())?;

    // Single (final) record: payload then the 0x02 delimiter.
    let mut record = payload.to_vec();
    record.push(0x02);
    key.seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut record)
        .map_err(|_| "seal failed".to_string())?;

    // Header: salt(16) || record-size u32be || keyid-len u8 || as_public(65).
    let mut body = Vec::with_capacity(16 + 4 + 1 + as_public.len() + record.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&4096u32.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&record);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vapid_public_key_is_uncompressed_p256_point() {
        let mgr = PushManager::new().expect("keygen");
        let bytes = URL_SAFE_NO_PAD.decode(mgr.vapid_public_key()).unwrap();
        assert_eq!(bytes.len(), 65);
        assert_eq!(bytes[0], 0x04); // uncompressed point marker
    }

    #[test]
    fn vapid_header_shape() {
        let mgr = PushManager::new().expect("keygen");
        let h = mgr
            .vapid_header("https://updates.push.services.mozilla.com/wpush/v2/abc")
            .unwrap();
        assert!(h.starts_with("vapid t="));
        let jwt = h.split("t=").nth(1).unwrap().split(',').next().unwrap();
        assert_eq!(jwt.split('.').count(), 3, "JWT must have 3 segments");
        // ES256 signatures are raw r||s = 64 bytes.
        let sig = URL_SAFE_NO_PAD.decode(jwt.split('.').nth(2).unwrap()).unwrap();
        assert_eq!(sig.len(), 64);
    }

    #[test]
    fn encrypted_body_layout_and_roundtrip() {
        // Drive the derivation with a fixed "shared secret" and check we can
        // decrypt our own record with independently derived keys.
        let ecdh_secret = [7u8; 32];
        let auth = [3u8; 16];
        let ua_pub = {
            let mut p = vec![0x04];
            p.extend_from_slice(&[1u8; 64]);
            p
        };
        let as_pub = {
            let mut p = vec![0x04];
            p.extend_from_slice(&[2u8; 64]);
            p
        };
        let salt = [9u8; 16];
        let payload = br#"{"title":"t","body":"b"}"#;

        let (cek, nonce) = derive_cek_nonce(&ecdh_secret, &auth, &ua_pub, &as_pub, &salt).unwrap();
        assert_eq!(cek.len(), 16);
        assert_eq!(nonce.len(), 12);

        let body = seal_record(&cek, &nonce, payload, &salt, &as_pub).unwrap();
        // Header layout.
        assert_eq!(&body[..16], &salt);
        assert_eq!(&body[16..20], &4096u32.to_be_bytes());
        assert_eq!(body[20], 65);
        assert_eq!(&body[21..86], as_pub.as_slice());

        // Decrypt the record and verify payload + delimiter.
        let ct = body[86..].to_vec();
        let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &cek).unwrap());
        let n = aead::Nonce::try_assume_unique_for_key(&nonce).unwrap();
        let mut buf = ct;
        let plain = key.open_in_place(n, aead::Aad::empty(), &mut buf).unwrap();
        assert_eq!(&plain[..payload.len()], payload);
        assert_eq!(plain[payload.len()], 0x02);
    }

    #[test]
    fn working_filter_requires_min_duration() {
        let mgr = PushManager::new().expect("keygen");
        // Instant transition: not push-worthy.
        assert!(!mgr.note_working("t1", true) && !mgr.note_working("t1", false));
        // Unknown terminal going idle: not push-worthy.
        assert!(!mgr.note_working("t2", false));
    }
}
