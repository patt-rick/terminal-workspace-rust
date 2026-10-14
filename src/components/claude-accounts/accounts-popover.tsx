import type { ReactNode } from 'react'
import { useClaudeAccounts } from '../../state/claude-accounts'
import { useApiKeys } from '../../state/apikeys'
import { useUi } from '../../state/ui'
import { useUsage } from '../../state/usage'
import { formatAgo, sortAccounts } from '../../lib/claude-accounts'
import { AccountRow, ActiveBadge } from './account-row'

/**
 * The dropdown under the title-bar pill: login-account list, API-key row
 * (synthesized from Anthropic provider entries), and footer actions.
 * Rendered inside a fixed overlay owned by AccountPill.
 */
export function AccountsPopover({ onClose }: { onClose: () => void }) {
  const s = useClaudeAccounts()
  const apiKeys = useApiKeys((st) => st.keys)
  const openSettings = useUi((st) => st.openSettings)

  const anthropicKeys = apiKeys.filter((k) => k.provider === 'anthropic' && k.hasValue)
  const apiKeyActive = anthropicKeys.some((k) => k.enabled)
  const sorted = sortAccounts(s.accounts, s.activeAccountId)

  return (
    <div className="flex max-h-[70vh] w-[340px] flex-col overflow-hidden rounded-xl border border-border bg-overlay shadow-xl">
      <div className="flex h-11 flex-shrink-0 items-center gap-1.5 border-b border-border pl-3.5 pr-2">
        <span className="text-sm font-semibold text-foreground">Claude accounts</span>
        <span className="text-xs text-muted">{s.accounts.length}</span>
        <span className="ml-auto text-[11px] text-muted">
          {s.usageFetchedAt ? `Usage ${formatAgo(s.usageFetchedAt, Date.now())}` : ''}
        </span>
        <button
          type="button"
          onClick={() => void s.refreshUsage(true)}
          title="Refresh usage"
          aria-label="Refresh usage"
          className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/55 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 11a8 8 0 1 0-2.3 5.7" />
            <path d="M20 4v7h-7" />
          </svg>
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        {s.accounts.length === 0 && anthropicKeys.length === 0 && (
          <div className="px-1.5 py-3 text-center text-xs leading-relaxed text-muted">
            No Claude accounts yet. Log in, or import the account the claude CLI already uses.
          </div>
        )}

        {sorted.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            usage={s.usage[a.id]}
            isActive={a.id === s.activeAccountId && !apiKeyActive}
            busy={s.busy || s.loggingIn}
            onSwitch={() => void s.switchTo(a.id)}
            onRemove={() => void s.remove(a.id)}
            onRelogin={() => void s.addViaOauth(a.email)}
          />
        ))}

        {anthropicKeys.map((k) => (
          <div
            key={k.id}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 ${
              k.enabled ? 'border-accent/50 bg-accent/5' : 'border-border'
            }`}
          >
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-foreground/10 text-foreground/70">
              <KeyIcon />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">{k.label}</span>
                {k.enabled && <ActiveBadge />}
              </div>
              <div className="truncate text-xs text-muted">
                API key · pay per token{k.enabled ? ' · overrides login' : ''}
              </div>
            </div>
            {!k.enabled && (
              <button
                type="button"
                onClick={() => void s.switchToApiKey(k.id)}
                disabled={s.busy || s.loggingIn}
                title="Enable this key — claude will bill the API key instead of a subscription"
                className="flex h-7 shrink-0 items-center rounded-md border border-border px-2.5 text-xs font-medium text-foreground/85 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
              >
                Switch
              </button>
            )}
          </div>
        ))}

        {s.error && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs text-danger">
            <span className="min-w-0 flex-1 break-words">{s.error}</span>
            <button
              type="button"
              onClick={s.clearError}
              aria-label="Dismiss"
              className="flex-shrink-0 opacity-70 hover:opacity-100"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 border-t border-border bg-foreground/5 p-2">
        {s.loggingIn ? (
          <div className="flex h-8 items-center gap-2 pl-1.5 text-xs text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
            <span className="min-w-0 flex-1 truncate">Finish signing in in your browser…</span>
            <FooterButton onClick={() => void s.cancelLogin()}>Cancel</FooterButton>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            <FooterButton primary icon={<PlusIcon />} onClick={() => void s.addViaOauth()}>
              Log in
            </FooterButton>
            <FooterButton
              icon={<ImportIcon />}
              onClick={() => void s.importCli()}
              disabled={s.busy}
              title="Import the account already logged in via the claude CLI"
            >
              Import from CLI
            </FooterButton>
            <FooterButton
              icon={<KeyIcon />}
              onClick={() => {
                onClose()
                openSettings('ai')
              }}
            >
              API keys
            </FooterButton>
            <FooterButton
              icon={<ChartIcon />}
              onClick={() => {
                onClose()
                useUsage.getState().openPage()
              }}
            >
              Usage
            </FooterButton>
          </div>
        )}
      </div>
    </div>
  )
}

function FooterButton({
  children,
  icon,
  primary,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode
  icon?: ReactNode
  primary?: boolean
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 ${
        primary
          ? 'bg-accent font-semibold text-accent-foreground shadow-sm hover:brightness-110'
          : 'border border-border text-foreground/85 hover:bg-foreground/10 hover:text-foreground'
      }`}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  )
}

const iconProps = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  className: 'flex-shrink-0',
}

function PlusIcon() {
  return (
    <svg {...iconProps}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function ImportIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  )
}

function KeyIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9" />
      <path d="m17 6 3 3" />
    </svg>
  )
}

function ChartIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M3 20h18" />
    </svg>
  )
}
