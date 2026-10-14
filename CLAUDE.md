# Forge Neo Client

Electron + React + TypeScript desktop client for the Forge Neo image-generation API. The user runs
Forge Neo on a home PC and connects from a laptop over VPN (Tailscale/WireGuard). One user, no login.

**Start every session by reading `docs/STATUS.md`** — current state, what is next, every decision
taken so far and what is waiting on the user. Talk to the user in Russian; code, comments, commits,
UI strings, README and CHANGELOG are English.

## Documents

- Spec (approved, the binding authority): `docs/superpowers/specs/2026-10-13-forge-neo-client-design.md`
- Plans: `docs/superpowers/plans/` — plan 1 (core) is being executed; plans 2 (gallery features) and 3 (server tools, upscale) are not written yet.
- Real-server facts from the probe: `docs/forge-api-notes.md`
- Status, decisions, open items: `docs/STATUS.md`

## Commands

- `pnpm dev` — run the app with hot reload.
- `pnpm test` — all tests (vitest inside Electron-as-Node, so better-sqlite3 has the app's ABI). One file: `pnpm test <path>`.
- `src/main/e2e.test.ts` — end-to-end test of the main modules (real SQLite file, image store, Forge client, catalog, runner) against the mock Forge, without Electron; runs as part of `pnpm test`.
- `pnpm typecheck` — renderer/main/preload and Node-side config.
- `pnpm build` — production build. **Run it before every commit**: vitest does not compile CSS modules, so CSS errors only show up here.
- `pnpm mock-forge` — fake Forge on port 7861 (`PORT=<n>` to change; 7861 is often taken). Used by tests and for manual runs.
- `node tools/probe/probe.mjs http://HOST:7860` — read-only probe of a real Forge; writes `tools/probe/probe-report.json` (git-ignored, holds private paths).

## Smoke run

`FNC_SMOKE=1` (dev builds only) loads `src/main/fnc-smoke.ts`, which drives `window.api` against a mock Forge, prints one `FNC_SMOKE {...}` JSON line and quits. Build first, start `PORT=7871 pnpm mock-forge`, then:
`FNC_SMOKE=1 FNC_SMOKE_SERVER=127.0.0.1:7871 node_modules/.bin/electron . --user-data-dir=<temp dir>`. Always use a throwaway `--user-data-dir`.

## Manual check in the real window

`pnpm build`, then a slow mock so progress is visible: `node_modules/.bin/tsx -e "import('./tools/mock-forge/server.ts').then((m) => m.startMockForge({ port: 7881, stepMs: 300 }))"`, then `node_modules/.bin/electron . --remote-debugging-port=9333 --user-data-dir=<temp dir>` and drive or screenshot the page over CDP (`http://127.0.0.1:9333/json`). The window opens on the user's desktop: tell the user before starting, and stop both processes afterwards.

## Layout

- `src/main/` — owns all state. `forge/` (HTTP client, catalog, connection monitor, active-server holder, probe findings), `generation/payload.ts` (params → txt2img body), `queue/` (runner, speed), `storage/` (SQLite, repos, image files, `fnc-img://` resolver), `oplog/` (operation log), `ipc/register.ts` (every IPC handler), `index.ts` (Electron wiring, protocol, window).
- `src/preload/index.ts` — exposes exactly the `Api` from `src/shared/ipc.ts` as `window.api`.
- `src/shared/` — `types.ts`, `ipc.ts` (Api, channels, `IpcErrorKey`), `profiles.ts` (model families; imported by main and renderer, no Node imports).
- `src/renderer/` — React. `state/store.ts` (zustand, provided via `StoreProvider`; `state/gallery-items.ts` merges jobs and images and lays out columns), `components/` (+ `ui/` primitives; `use-pending-delete.ts` drives delete-with-undo), `format.ts` (shared display formatters such as `baseName`), `locales/en.ts`, `i18n/`, `styles/` (`tokens.css`, `base.css`, `motion.module.css`). The prompt bar publishes its height as the root CSS variable `--prompt-bar-h`; floating content pads by it.
- `tools/mock-forge/server.ts`, `tools/probe/probe.mjs`.

## Rules

- Every commit that changes behaviour adds a line under `## [Unreleased]` in `CHANGELOG.md` and keeps `README.md` accurate.
- **This file and `docs/STATUS.md` are part of the work**: update `CLAUDE.md` in the same commit that changes a command, convention or layout; update `docs/STATUS.md` whenever a task finishes, a decision is taken, or something starts waiting on the user.
- Every user-visible string goes through `t()` and lives in `src/renderer/locales/en.ts`; no display literals in JSX or in main. A guard test (`src/renderer/i18n/no-literals.test.ts`, AST-based) enforces it, including in tests.
- Errors cross boundaries as codes, never sentences: jobs carry `JobError { code, status?, detail?, missing? }`; rejected IPC calls carry exactly one `IpcErrorKey` (the preload unwraps Electron's wrapper). The renderer maps codes to catalog text.
- All HTTP to Forge is made from main. The renderer runs with `contextIsolation`, `sandbox`, no `nodeIntegration`; images reach it only through `fnc-img://` (CSP allows it in `img-src` only).
- Prompts never reach the operation log, and neither does Forge's error text for a generation (it may echo the prompt).
- Styling: only CSS variables from `tokens.css` (colours, spacing, radii, durations, heights, z-index); text ≥ 12 px; weights 400/500; no uppercase; animate only `transform`/`opacity`; shared fade via `composes: fadeIn from '…/motion.module.css'` (never `:global()` in an animation shorthand — it breaks the build); a signal colour is never the only indicator. No UI kits; Radix Primitives and Phosphor icons only.
- Never commit the user's real file paths or model file names (from probe reports or their Forge); use fictional examples of the same shape.
- Write text containing backslashes (Windows paths) with the Edit/Write tools, not shell `sed`/`echo`/heredocs/inline scripts: sequences like backslash-f get turned into control bytes (this corrupted the `%APPDATA%\forge-neo-client` path in README twice). Before committing docs, check: `grep -nP '[\x00-\x08\x0B\x0C\x0E-\x1F]' *.md docs/*.md` must print nothing.
- Tests live next to the code (`x.ts` → `x.test.ts`); TypeScript strict; aliases `@shared/*`, `@main/*`, `@renderer/*`. Write the failing test first.

## Working method

Plans are executed with superpowers:subagent-driven-development: one implementer subagent per task, a reviewer subagent after it, fix rounds until clean. Briefs, reports and the full ledger live in `.superpowers/sdd/<plan>/` (git-ignored, local only); `docs/STATUS.md` is the tracked summary and must stay in step with it.
