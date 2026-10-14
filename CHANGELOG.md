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
- IPC hardening: renderer-side errors carry only stable keys (`extractErrorKey`), `jobs:enqueue` validates every field and drops unknown keys, a failed file removal no longer leaves a half-deleted image, a startup failure exits instead of leaving an invisible process, shutdown waits at most 5 s for the queue, and the window is single-instance with navigation and pop-ups blocked. An opt-in smoke run (`FNC_SMOKE=1`) exercises the wiring against the mock server.
- Renderer state store (`createAppStore`, provided through `StoreProvider`): settings, connection, model catalog, generation parameters with family defaults, active jobs with progress, and the first 100 images, kept current by the main-process events. `init()` is safe to call twice.
- First screen: a 44 px top bar that doubles as the window drag area, a connection chip (state label with a coloured dot, latency or reconnect attempt), and a server dialog that opens by itself until a Forge address is set and shows a mapped, text-only error when the address is wrong. A dismissible notice shows the last failed action.
- A catalog entry for every IPC error key and `errorText()`, which turns a rejected `window.api` call into catalog text.
- Fixed the build: the `animation: :global(fade-in)` declaration in the Select and Tooltip styles was a CSS syntax error; those styles, and the new dialog, now compose a shared fade-in from `styles/motion.module.css`.
- Review fixes for the first screen: a connect that cannot refresh settings now fails visibly instead of leaving the dialog stuck, the chip reads "No server" until an address is set, a failed catalog load shows a notice with Retry (one shared `Notice` component), finished jobs are never re-added by stale responses, the dialog keeps its accessible description, and the main process samples the connection on show/restore and publishes it when the page loads.
- Prompt bar and parameters panel: a floating prompt bar (growing prompt field, Ctrl+Enter to generate, ArrowUp to recall the last prompt, optional negative prompt, checkpoint, ratio, steps and image count, Generate), a right-hand panel with the model card (each part found or not found), the sampling parameters the model family uses, seed and size, and the VAE/text-encoder list; plus a "No checkpoints found" state with Refresh and a single z-index scale in the design tokens.
- Gallery: tiles in columns (at least two, one per 226 px) with new items at the top-left. Waiting jobs have a dashed border and a queue number; the running job shows the live preview, stage, step count, speed, elapsed seconds and a 2 px progress line; failed and interrupted jobs show a message mapped from the error code (the server text below it, shortened with the full text in a tooltip), Retry and Dismiss. Finished images show the frame marking (№, seconds, size) and a Delete button on hover and keyboard focus; Delete hides the image and offers Undo for 5 seconds. Older images load 100 at a time as you scroll, and an empty gallery invites the first prompt.
- Store: `dismissJob` and `loadMoreImages` (older images, 100 at a time).
- End-to-end test of the main process (`src/main/e2e.test.ts`): the real database, image store, Forge client, catalog and queue against the mock Forge, covering a two-image run with its log entries, the server going down mid-queue and coming back, and recovery of a job left running by a previous launch.
- README: what version 0.1.0 does, where the database, images and operation log live, how to run the probe, and the known limitations.

### Changed

- The negative-prompt field no longer clips by one pixel, an empty model card renders nothing, and the top bar height and the panel slide-out time come from design tokens.
- Probe findings from a real Forge Neo server: shift is sent in the `distilled_cfg_scale` field instead of an option, checkpoint previews are requested from `/sd_extra_networks/thumb`, and a checkpoint's family is detected from its whole title, folders included. New parameter sets start with the default module list the server keeps for the family.
- Steps (1-150, in the prompt bar) and CFG, Distilled CFG and Shift (in the parameters panel) are now sliders with a value readout, built on a new `Slider` primitive (Radix Slider; arrows, Page Up/Down, Home/End).
- The prompt bar fits at every window width: the Model select takes the remaining space and shortens a long checkpoint name (full name on hover), the other controls keep their size, and at narrow widths the controls move to a second line under the model instead of overflowing. The bar is up to 880 px wide and always leaves room for the open parameters panel.
- The Model menu lists checkpoints grouped by model family (SDXL, Z-Image, Qwen, Lumina, Krea 2, Anima), each group sorted by name ignoring case, with numbers in natural order.
- `pnpm mock-forge` takes `MOCK_CATALOG=many` (a long mixed-family checkpoint list with an overlong name) and `STEP_MS` (time per fake step).

### Fixed

- Dropdown menus with a long list scroll (mouse wheel and keyboard) instead of running off the window; they stay inside the window and open on the selected item.
- `Ctrl+Enter` also generates from the negative-prompt field.
- The Images field in the prompt bar no longer overlaps the next control, and the running job's caption stays on one line (shortened with an ellipsis, full text on hover).

- A slow `/sdapi/v1/loras` no longer breaks the catalog: it has a 60 s timeout of its own, and when it fails the catalog loads with no LoRAs and logs a warning.
