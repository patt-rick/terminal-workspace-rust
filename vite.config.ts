import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createRequire } from 'node:module'

// Tauri expects a fixed port and surfaces the host/port via env vars.
const host = process.env.TAURI_DEV_HOST

const pkg = createRequire(import.meta.url)('./package.json') as { version: string }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // prevent vite from obscuring rust errors
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
