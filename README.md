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

The app keeps everything under Electron's per-user data folder (`%APPDATA%\forge-neo-client` on Windows):

- `forge-neo-client.db` - SQLite database with servers, jobs, image records, settings and the operation log (entries older than 90 days are purged at start-up).
- `images/` - generated PNGs in month folders (`images/2026-10/`) and JPEG thumbnails in `images/thumbs/`.

## Screens

- **Top bar** - a 44 px strip that drags the window. It shows the connection chip (Connected, Slow, Reconnecting with the attempt count, or Offline) and a settings button; both open the server dialog.
- **Server dialog** - the address of the PC that runs Forge Neo (started with `--api --listen`). It opens by itself until an address is set and cannot be dismissed before then. A wrong address shows what to check under the field.
- **Prompt bar** - floats at the bottom centre. The prompt field grows to six lines; `Ctrl+Enter` generates and `Up Arrow` in an empty field brings back the last prompt. The row below holds the checkpoint, aspect ratio, steps, image count, a Negative toggle (not offered for families without a negative prompt), the All parameters button and Generate.
- **Parameters panel** - slides in from the right over the canvas (`Esc` closes it). It shows the model card (checkpoint and modules, each marked found or not found), the sampling parameters of the model family, seed, size, and the list of VAE and text encoder modules.
- **Gallery** - the canvas. Tiles sit in columns (at least two, about one per 226 px) and new ones appear at the top-left. A waiting job has a dashed border and its place in the queue; the running one shows the live preview, stage, step count, speed and elapsed time with a progress line, and both have Cancel. A failed or interrupted job shows what happened, with Retry and Dismiss. A finished image shows its frame marking (number, seconds, size) and a Delete button on hover or keyboard focus; deleting hides the image and Undo stays available for 5 seconds. Older images load as you scroll.
