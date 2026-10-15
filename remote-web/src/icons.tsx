import type { ReactNode } from 'react'

// Same stroke style as the desktop's inline icons: 24-unit grid, round caps.
function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

type P = { size?: number }

export const MenuIcon = (p: P) => (
  <Icon {...p}>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
  </Icon>
)

export const BranchIcon = (p: P) => (
  <Icon {...p}>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </Icon>
)

export const CloseIcon = (p: P) => (
  <Icon {...p}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </Icon>
)

export const TerminalIcon = (p: P) => (
  <Icon {...p}>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </Icon>
)

export const SparklesIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </Icon>
)

export const HistoryIcon = (p: P) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <polyline points="3 3 3 8 8 8" />
    <polyline points="12 7 12 12 15 14" />
  </Icon>
)

export const ChevronLeftIcon = (p: P) => (
  <Icon {...p}>
    <polyline points="15 18 9 12 15 6" />
  </Icon>
)
export const ChevronRightIcon = (p: P) => (
  <Icon {...p}>
    <polyline points="9 18 15 12 9 6" />
  </Icon>
)
export const ChevronUpIcon = (p: P) => (
  <Icon {...p}>
    <polyline points="18 15 12 9 6 15" />
  </Icon>
)
export const ChevronDownIcon = (p: P) => (
  <Icon {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Icon>
)

export const UploadIcon = (p: P) => (
  <Icon {...p}>
    <path d="M12 16V4" />
    <polyline points="7 9 12 4 17 9" />
    <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </Icon>
)
