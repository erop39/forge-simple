import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer'),
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/renderer/**', '**/node_modules/**'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'renderer',
          globals: true,
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
})
