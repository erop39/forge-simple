# Forge Neo Client

A desktop client (Electron + React + TypeScript) for the Forge Neo image-generation API.

## Requirements

- Node.js and pnpm.
- A running Forge Neo instance started with `--api --listen`.

## Install

```
pnpm install
```

The `postinstall` step rebuilds `better-sqlite3` for Electron's ABI.

## Commands

- `pnpm dev` - start the app in development mode.
- `pnpm build` - build main, preload and renderer into `out/`.
- `pnpm test` - run the test suite.
- `pnpm typecheck` - run the TypeScript checks.
- `pnpm mock-forge` - run a mock Forge server on port 7861 (override with `PORT`); it answers the `/sdapi/v1` endpoints the client uses and fakes generation progress.

## Probe

`node tools/probe/probe.mjs` queries a live Forge instance and writes a JSON report of the API behaviour the client depends on (see `docs/forge-api-notes.md`).

## Where data lives

The app keeps everything under Electron's per-user data folder (`%APPDATA%orge-neo-client` on Windows):

- `forge-neo-client.db` - SQLite database with servers, jobs, image records, settings and the operation log (entries older than 90 days are purged at start-up).
- `images/` - generated PNGs in month folders (`images/2026-10/`) and JPEG thumbnails in `images/thumbs/`.
