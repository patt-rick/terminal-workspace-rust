//! A minimal self-contained HTML client served at `/`, for exercising milestone
//! 3a from a localhost browser (pair → list → attach → type → create → close +
//! snapshot replay). The real mobile-first xterm.js SPA lands in milestone 3b.

pub const TEST_CLIENT: &str = r##"<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Terminal Workspace — Remote (3a test)</title>
<style>
  body { font: 13px ui-monospace, Menlo, Consolas, monospace; margin: 0; background:#1a1b26; color:#c0caf5; }
  header { padding: 8px 12px; background:#16161e; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  #status { margin-left:auto; opacity:.7; }
  button { font:inherit; background:#292e42; color:#c0caf5; border:1px solid #3b4261; border-radius:4px; padding:3px 8px; cursor:pointer; }
  button:hover { background:#3b4261; }
  input { font:inherit; background:#1f2335; color:#c0caf5; border:1px solid #3b4261; border-radius:4px; padding:3px 6px; }
  main { display:flex; height: calc(100vh - 42px); }
  #side { width:280px; overflow:auto; border-right:1px solid #292e42; padding:8px; }
  .proj { margin-bottom:10px; }
  .proj > .name { font-weight:bold; color:#7aa2f7; }
  .term { display:flex; gap:6px; align-items:center; padding:2px 0; }
  .term .t { flex:1; cursor:pointer; }
  .term .t:hover { text-decoration:underline; }
  .term .dead { opacity:.4; }
  #pane { flex:1; display:flex; flex-direction:column; }
  #out { flex:1; margin:0; padding:8px; overflow:auto; white-space:pre-wrap; word-break:break-all; }
  #inputrow { display:flex; gap:6px; padding:6px 8px; border-top:1px solid #292e42; }
  #keyinput { flex:1; }
</style>
</head>
<body>
<header>
  <span id="pairbox">
    Pairing code: <input id="code" size="8" inputmode="numeric" placeholder="000000" />
    <button id="connect">Connect</button>
  </span>
  <button id="mkshell" disabled>+ Shell</button>
  <button id="mkclaude" disabled>+ Claude</button>
  <span id="status">disconnected</span>
</header>
<main>
  <div id="side"></div>
  <div id="pane">
    <pre id="out"></pre>
    <div id="inputrow">
      <input id="keyinput" placeholder="click here and type — Enter/Ctrl-C/Backspace/Tab/Esc work" disabled />
      <span id="attached" style="opacity:.6"></span>
    </div>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let ws = null, token = null, state = null;
let attachedId = null, attachedTag = null;
const decoders = {}; // tag -> TextDecoder (streaming, handles split UTF-8)

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const strToB64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const setStatus = (s) => { $("status").textContent = s; };

$("connect").onclick = async () => {
  const code = $("code").value.trim();
  if (!code) return;
  setStatus("pairing…");
  try {
    const r = await fetch("/pair", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ code }) });
    if (!r.ok) { setStatus("pairing failed"); return; }
    token = (await r.json()).token;
    openWs();
  } catch (e) { setStatus("error: " + e); }
};

function openWs() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => ws.send(JSON.stringify({ type:"hello", token }));
  ws.onclose = () => { setStatus("disconnected"); enable(false); };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return onBinary(new Uint8Array(ev.data));
    const m = JSON.parse(ev.data);
    onControl(m);
  };
}

function enable(on) {
  $("mkshell").disabled = !on; $("mkclaude").disabled = !on; $("keyinput").disabled = !on;
  $("pairbox").style.display = on ? "none" : "";
}

function onControl(m) {
  switch (m.type) {
    case "hello.ok":
      state = m.state; setStatus("connected · v" + m.appVersion); enable(true); renderSide(); break;
    case "hello.err": setStatus("auth failed: " + m.message); break;
    case "term.attached":
      attachedId = m.terminalId; attachedTag = m.tag; decoders[m.tag] = new TextDecoder();
      $("out").textContent = ""; $("attached").textContent = "attached " + m.terminalId.slice(0,8); break;
    case "term.snapshot":
      if (decoders[m.tag]) $("out").textContent += decoders[m.tag].decode(b64ToBytes(m.data), { stream:true }); scrollOut(); break;
    case "term.created":
      addTermToState(m.terminal); renderSide(); attach(m.terminal.id); break;
    case "term.closed":
      removeTermFromState(m.terminalId); renderSide(); if (attachedId === m.terminalId) { attachedId=null; $("attached").textContent=""; } break;
    case "session.evicted": setStatus("evicted — another device connected"); break;
    case "error": setStatus("error: " + m.message); break;
  }
}

function onBinary(buf) {
  const tag = (buf[0]<<24 | buf[1]<<16 | buf[2]<<8 | buf[3]) >>> 0;
  if (tag !== attachedTag || !decoders[tag]) return;
  $("out").textContent += decoders[tag].decode(buf.subarray(4), { stream:true });
  scrollOut();
}
function scrollOut(){ const o=$("out"); o.scrollTop = o.scrollHeight; }

function renderSide() {
  const side = $("side"); side.innerHTML = "";
  for (const p of state.projects) {
    const d = document.createElement("div"); d.className = "proj";
    const n = document.createElement("div"); n.className = "name"; n.textContent = p.name; d.appendChild(n);
    for (const t of p.terminals) {
      const row = document.createElement("div"); row.className = "term";
      const label = document.createElement("span"); label.className = "t" + (t.live ? "" : " dead");
      label.textContent = t.name; label.onclick = () => attach(t.id);
      const close = document.createElement("button"); close.textContent = "×"; close.onclick = () => ws.send(JSON.stringify({ type:"term.close", terminalId: t.id }));
      row.appendChild(label); row.appendChild(close); d.appendChild(row);
    }
    d.dataset.pid = p.id;
    d.querySelector(".name").onclick = () => { side.dataset.selected = p.id; };
    side.appendChild(d);
  }
}
function selectedProject(){ return $("side").dataset.selected || (state.projects[0] && state.projects[0].id); }

function attach(id) {
  if (attachedId) ws.send(JSON.stringify({ type:"term.detach", terminalId: attachedId }));
  ws.send(JSON.stringify({ type:"term.attach", terminalId: id }));
}
function addTermToState(t){ const p = state.projects.find(p=>p.id===t.projectId); if(p) p.terminals.push(t); }
function removeTermFromState(id){ for(const p of state.projects) p.terminals = p.terminals.filter(t=>t.id!==id); }

$("mkshell").onclick = () => ws.send(JSON.stringify({ type:"term.create", projectId: selectedProject(), kind:"shell" }));
$("mkclaude").onclick = () => ws.send(JSON.stringify({ type:"term.create", projectId: selectedProject(), kind:"claude" }));

$("keyinput").addEventListener("keydown", (e) => {
  if (!attachedId) return;
  let data = null;
  if (e.key === "Enter") data = "\r";
  else if (e.key === "Backspace") data = "\x7f";
  else if (e.key === "Tab") data = "\t";
  else if (e.key === "Escape") data = "\x1b";
  else if (e.ctrlKey && e.key.length === 1) data = String.fromCharCode(e.key.toUpperCase().charCodeAt(0) & 31);
  else if (e.key.length === 1) data = e.key;
  if (data !== null) {
    e.preventDefault();
    ws.send(JSON.stringify({ type:"term.input", terminalId: attachedId, data: strToB64(data) }));
  }
});
</script>
</body>
</html>
"##;
