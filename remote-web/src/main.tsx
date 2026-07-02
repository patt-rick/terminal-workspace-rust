import { createRoot } from 'react-dom/client'
import { App } from './app'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(<App />)
