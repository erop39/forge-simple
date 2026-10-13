# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Application scaffold: Electron + React + TypeScript with electron-vite, a vitest runner that uses Electron's ABI for better-sqlite3, and a dark frameless main window.
- `tools/probe/probe.mjs`, a script that probes a live Forge instance and records its API behaviour; missing option keys are reported as `null`.
- String catalog and typed message lookup (`t()`), shared domain types, and a test that rejects user-visible string literals in renderer components.
- Design tokens, base styles, and the first UI primitives: `Button`, `IconButton`, `ParamRow`, `Select`, `Tooltip`.
- SQLite storage layer: a migrated database and repositories for servers, jobs, images and settings.
- Operation log: persisted, filterable entries that never contain prompts, with retention purge; a failed write never interrupts the operation.
- Forge HTTP client (`src/main/forge/client.ts`) with typed calls, address normalisation and one error type, plus a mock Forge server (`pnpm mock-forge`) for tests and manual runs.
- Model family profiles (`src/shared/profiles.ts`): per-family field flags and defaults, checkpoint family detection by file name, aspect-ratio dimensions and default parameters that adapt to the sampler and scheduler lists a server offers.
- txt2img request builder (`src/main/generation/payload.ts`): a pure function from generation parameters to the Forge request body, applying family profiles, LoRA tags, model modules, clip skip and shift.
- Model catalog (`src/main/forge/catalog.ts`): checkpoints, modules, LoRAs, samplers, schedulers and upscalers loaded in parallel and cached, with a check that flags a checkpoint or module a job needs but the server no longer lists.
- Image file store (`src/main/storage/image-store.ts`) writing PNGs and thumbnails under month folders, and safe `fnc-img://` image URLs (`image-protocol.ts`) that cannot resolve outside the images folder.
- Generation queue (`src/main/queue/runner.ts`): one job at a time with per-second progress and previews, cancel, retry, restart recovery, a pause while Forge is unreachable, and a failed job for a missing checkpoint or module; plus a steps-per-second helper.
- Connection status (`src/main/forge/connection.ts`): a pure state machine (connected, slow, reconnecting, offline) and a monitor that logs loss and recovery of the connection once each.
- Job errors are stored as structured codes (`JobError`) instead of sentences; the queue now fails jobs it cannot start, ends a job when 15 progress polls in a row fail, and restarts cleanly after stop.
- Typed IPC between the window and the main process (`src/shared/ipc.ts`, `src/main/ipc/register.ts`, preload bridge `window.api`): settings with a checked server address, model catalog, generation queue, image gallery and connection status, plus live events. Errors cross as stable keys, never English text. The main process now wires storage, queue, connection monitor and the `fnc-img://` image protocol together and shuts down in order (monitor, queue, log, database).
