import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Build to a single self-contained index.html, then copy it into the Rust crate
// where server.rs embeds it with include_str!. Committing the generated file
// keeps the crate compilable without a Node build in the loop.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    viteSingleFile(),
    {
      name: 'copy-to-rust-crate',
      closeBundle() {
        copyFileSync(here('./dist/index.html'), here('../src-tauri/src/remote/web_client.html'))
      },
    },
  ],
  build: {
    outDir: 'dist',
    // Inline everything so include_str! embeds one file.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
  },
})
