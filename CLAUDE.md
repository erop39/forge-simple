# Forge Neo Client

Electron + React + TypeScript desktop client for the Forge Neo image-generation API.
Design spec: `docs/superpowers/specs/2026-10-13-forge-neo-client-design.md`.

## Commands

- `pnpm dev` - run the app with hot reload.
- `pnpm test` - run all tests (vitest inside Electron-as-Node, so better-sqlite3 has the app's ABI). One file: `pnpm test <path>`.
- `pnpm typecheck` - type-check renderer/main/preload and Node-side config.

## Rules

- Every commit that changes behaviour adds a line under `## [Unreleased]` in `CHANGELOG.md` and keeps `README.md` accurate. Both files are in English.
- Every user-visible string goes through `t()` and lives in `src/renderer/locales/en.ts`; no display string literals in JSX or in the main process.
- All HTTP requests to Forge are made from the main process. The renderer runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Tests live next to the code (`x.ts` -> `x.test.ts`); TypeScript is strict; path aliases are `@shared/*`, `@main/*`, `@renderer/*`.
