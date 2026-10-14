# Forge Neo Client

A desktop client (Electron + React + TypeScript) for the Forge Neo image-generation API. Forge runs
on one PC; the client runs on another machine (for example a laptop on the same VPN) and talks to
Forge's HTTP API. One user, no login.

## What version 0.1.0 does

- Keeps a list of Forge Neo servers and switches between them; shows whether the link is connected, slow, reconnecting or offline.
- Loads the server's checkpoints, VAE and text-encoder modules, samplers and schedulers, and detects
  each checkpoint's model family (SDXL, Z-Image, Qwen, Lumina, Krea 2, Anima) to pick sensible
  defaults and show only the parameters that family uses.
- Text-to-image generation from a floating prompt bar, with the full parameter set in a side panel.
  One request makes one image; asking for several queues several jobs.
- A queue in the app, not in Forge: jobs run one at a time, can be cancelled while waiting or running,
  and failed or interrupted jobs can be retried. If Forge becomes unreachable the queue pauses and
  continues by itself when Forge is back; the job that was running is marked interrupted. A job that
  was running when the app quit is marked interrupted on the next start, and the queue goes on.
- A gallery of everything generated, with live progress and preview for the running job, delete with
  Undo, and older images loaded as you scroll. Images are kept on this machine, not on the server
  (Forge is asked not to save them).
- An operation log in the database: queue events, start and finish of every generation with its
  duration, checkpoint changes, connection loss and recovery, errors. Prompts are never written to it.

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
- `pnpm mock-forge` - run a mock Forge server on port 7861 (override with `PORT`); it answers the `/sdapi/v1` endpoints the client uses and fakes generation progress. `MOCK_CATALOG=many` serves a long checkpoint list across model families; `STEP_MS` sets the time per fake step.

## Probe

`node tools/probe/probe.mjs http://HOST:7860` asks a live Forge instance read-only questions and writes
`tools/probe/probe-report.json` with the API behaviour the client depends on (see
`docs/forge-api-notes.md`). The report holds the server's model names and file paths, so it is
git-ignored; do not share it.

## Where data lives

The app keeps everything under Electron's per-user data folder (`%APPDATA%\forge-neo-client` on Windows):

- `forge-neo-client.db` - SQLite database with servers, jobs, image records, settings and the operation log. The log is the `oplog` table; entries older than 90 days are purged at start-up.
- `images/` - generated PNGs in month folders (`images/2026-10/`) and JPEG thumbnails in `images/thumbs/`.

## Screens

- **Top bar** - a 44 px strip that drags the window. It shows the connection chip (the active server's name and Connected, Slow, Reconnecting with the attempt count, or Offline) and a settings button; both open the server dialog.
- **Server dialog** - the saved Forge Neo servers (each started with `--api --listen`), each with a name and address; the active one is marked. Add, edit, delete (with confirmation) or Use a server. A new or changed address is tested before it is saved, and a wrong one shows what to check under the field. Switching is refused while a job runs. Queued jobs stay with the server they were queued on: those of an inactive server show "Waiting for <name>" and run once it is active again. Deleting a server removes its queued jobs; its images stay. With no saved server the dialog opens by itself on the add form.
- **Prompt bar** - floats at the bottom centre. The prompt field grows to six lines; `Ctrl+Enter` generates (from the prompt or the negative prompt) and `Up Arrow` in an empty prompt field brings back the last prompt. The row below holds the checkpoint (grouped by model family in its menu), aspect ratio, a steps slider, image count, a Negative toggle (not offered for families without a negative prompt), the All parameters button and Generate; in a narrow window the controls move to a second line under the checkpoint. Switching checkpoints keeps the selected image dimensions and proportions. The bookmark button next to the Negative toggle holds saved negative prompts: choosing one replaces the negative text (and opens the field), "Save current as preset…" names the current negative, and "Manage presets…" renames or deletes them. Switching checkpoints keeps the negative text.
- The prompt field appears as soon as the window opens. You can type while models load; Generate becomes available once a model is ready.
- **Parameters panel** - slides in from the right over the canvas (`Esc` closes it). It shows the model card (checkpoint and modules, each marked found or not found), the sampling parameters of the model family (CFG, Distilled CFG and Shift as sliders), seed, size, and the list of VAE and text encoder modules.
- **Gallery** - the canvas. Tiles sit in columns (at least two, about one per 226 px) and new ones appear at the top-left. A waiting job has a dashed border and its place in the queue; the running one shows the live preview, stage, step count, speed and elapsed time with a progress line, and both have Cancel. A failed or interrupted job shows what happened, with Retry and Dismiss. A finished image shows its frame marking (number, seconds, size) and a Delete button on hover or keyboard focus; deleting hides the image and Undo stays available for 5 seconds. Older images load as you scroll.
- **Image viewer** - click a finished image or focus it and press Enter to see the full-size file. The panel below shows the saved prompt, negative prompt when present, model, scheduler, sampler, steps, dimensions, actual seed, relevant guidance settings, generation time and enabled LoRAs. Copy prompt writes the saved positive prompt to the system clipboard. The arrow icons or Left/Right keys move through gallery images, loading older images as needed. The X icon or Escape closes the viewer and returns focus to the opening tile.

## Known limitations

Version 0.1.0 is the core: connect, generate, queue, gallery. Not in it yet (planned for later versions):

- img2img, hires fix and upscaling of a finished image.
- LoRA selection in the interface (the request builder supports LoRAs, the screens do not).
- Tags, search, "Reuse settings" and "Save as" for an image.
- Presets.
- A checkpoint gallery with previews.
- A server status panel (VRAM, resources), restarting Forge or unloading a model.
- Export and import.
