import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@main': resolve(import.meta.dirname, 'src/main'),
  '@renderer': resolve(import.meta.dirname, 'src/renderer'),
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { alias },
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') },
    },
  },
})
