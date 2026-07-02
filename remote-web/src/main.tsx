import { createRoot } from 'react-dom/client'
import { App } from './app'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

// PWA wiring. The manifest/icon links are added at runtime (rather than in
// index.html) so the single-file bundler doesn't try to resolve them at build
// time — they're served by the Rust server at their own URLs.
function addLink(rel: string, href: string): void {
  const l = document.createElement('link')
  l.rel = rel
  l.href = href
  document.head.appendChild(l)
}
addLink('manifest', '/manifest.webmanifest')
addLink('apple-touch-icon', '/icon.svg')

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

createRoot(document.getElementById('root')!).render(<App />)
