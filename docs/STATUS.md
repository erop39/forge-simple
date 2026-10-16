# Project status

Read this first in a new session. Keep it current: update it when a task finishes, a decision is
taken, or something starts waiting on the user. The plan for the coming versions is `docs/ROADMAP.md`.

## Where things stand

- Repository: `https://github.com/erop39/forge-simple` (public). Work branch `feature/core`; `main` holds only the spec and plan docs. No published commit carries the user's real Forge path or model names (scan: `node scripts/scan-private.mjs` before every push).
- Releases: `v0.1.0` (2026-10-15) and `v0.2.0` (2026-10-16) are tagged. `[Unreleased]` in `CHANGELOG.md` holds the next version, 0.3.0, which is built and waits for its release pass (see the roadmap). Every push is also tagged `ckpt-YYYYMMDD-N` as a rollback point (latest `ckpt-20261016-27`).
- Checks: 1043 tests pass, build and both typechecks pass; mock end-to-end tests cover txt2img, hires, img2img, upscale, search and tags, the lock, presets and a restart. Several features were also checked live in isolated Electron windows (own throwaway profile, mock Forge, and read-only calls to the real Forge and to Civitai); each row below says what was and was not seen.
- Plans: plans 1 (core), 2 (gallery and library) and 3 (generation and server tools) are complete, settings export/import and the integration check included. Plan 4 (local prompt assistant) is an outline only: `docs/superpowers/plans/2026-10-16-plan-4-prompt-assistant.md`.
- Agents: `AGENTS.md` is the guide for any agent; `CLAUDE.md` holds commands, layout and code rules.
- Design documents: `docs/archive-design.md` (phase 1 built), `docs/prompt-assistant-design.md` (proposal), `docs/image-viewer.md`, `docs/prompt-startup-fix.md`, `docs/forge-api-notes.md`, `docs/code-review-2026-10-14.md`.

## What exists (ledger by area)

| Area | State |
|---|---|
| Core: connection chip, catalog and family detection, txt2img with every parameter, queue with cancel and retry, gallery with live progress, SQLite, operation log | done in 0.1.0 |
| Servers and Forge control: saved servers, local Forge auto-detection, 500 recovery (unload), restart/unload from the app, connection monitor | done; restart enabled on the user's Forge (`--api-server-stop`) |
| Generation extras: hires fix with presets and an on/off switch, img2img, upscale with before/after slider, Send to hires, HD mark, per-family default VAE/text encoders, per-family default negative | done; hires and the families were run once on the real Forge (sdxl, krea2, anima, lumina; qwen and zimage refused because their default modules are not on that server) |
| Long-job safety (2026-10-16): a generation is given up as `stalled` after 45 s of an idle Forge (`state.job` ''); the tile says "no progress for N s" after 30 s; the start no longer waits more than 8 s for the LoRA list | done; on the user's Forge a hires job sat at `step 0/20` while Forge was idle and `/sd-models` and `/loras` streamed for minutes (Forge hashing new files); why Forge never answered the hires request is unknown |
| Gallery: virtualised masonry, keyboard, search and tags, selection and batch actions, hidden images behind a session lock, image viewer (zoom, reuse settings, tags, show in folder), focused view (latest request only), delete with Undo, Clear unfinished, settings presets | done; the focused view and the caption-button clearance of dialogs have not been seen by eye on the user's PC |
| Model library: checkpoint and LoRA galleries, previews, favorites, notes, family override, trigger words (inserted into the prompt), sorting, duplicate finder, own previews from generations, LoRA stack, LoRA gallery by current family, side panel on selection | done; LoRA list loads in the background when Forge is slow |
| Civitai (opt-in consent, never sends more than hashes for the lookup): lookup and newer-version check, trigger words, previews; browser with type, one or several base models, name, period, civitai.com or civitai.red, preview thumbnails, Download later list that empties itself when the file appears | done; browser checked live on both sites; "No preview" on civitai.com is Civitai's safe-for-work filter |
| Data: image storage folder, archives phase 1 (verified copy then removal; hidden images skipped; list; restore), Delete all generations (red button), settings backup with a choice of parts (additive import, nothing overwritten) | done; archive checked live on a seeded profile; the native file dialogs of the backup were not opened by hand |
| Monitoring: resource panel (VRAM, RAM, CPU, GPU) and the optional read-only Forge stats extension | done; the extension (`forge-extension/`) has never run on the user's Forge |
| Local prompt assistant | proposal and plan outline only; waits for the user's answers |
| Archive phases 2–3, instant start, installer | planned in `docs/ROADMAP.md` |

## Open review findings

The whole-project review of 2026-10-16 (`docs/code-review-2026-10-16.md`) found 1 Critical, 9 Important and about 30 Minor issues, none fixed yet. Fix the Critical and Important ones before the 0.3.0 release pass.

## Waiting on the user

- Go-ahead for the 0.3.0 release pass (roadmap): a walk through the real window, then review and tag.
- Answers to the six questions at the end of `docs/prompt-assistant-design.md` (where the LLM runs, runtime, target order, Russian input, uncensored models, auto-tagging).
- Answers to the open choices of `docs/archive-design.md` phases 2–3 (age rules were declined for phase 1: manual only).
- Not seen by eye yet: the Slow connection state, animations, the native caption buttons against dialogs, the focused view, the settings export/import dialogs.
- Install the stats extension on the Forge PC if the CPU and GPU gauges are wanted (steps in README).
- If Forge's hires hang happens again, Forge's console output at that moment would show the cause.
- Leftover throwaway test profiles from checks may sit in the system temp folder (mock data only); safe to delete.

## How to resume

1. Read `CLAUDE.md`, then this file, then `docs/ROADMAP.md`.
2. On a new PC: clone `https://github.com/erop39/forge-simple`, `git checkout feature/core`, `pnpm install` (see README). Pull before you start, push when a task is done, after the private-data scan described in `CLAUDE.md`, then tag `ckpt-…`.
3. The detailed per-task ledger of plan 1/2 (`.superpowers/sdd/…`) exists only on the PC that wrote it (git-ignored); this file, `CHANGELOG.md` and `git log` are the record.
4. Work in one session on a mid-tier model (see "Working method" in `CLAUDE.md`); a reviewer subagent per milestone, the most capable model only for a whole-branch review.

## Decisions taken after 0.1.0

- Civitai is opt-in (`settings['civitai.enabled']`): the file lookup sends only SHA-256 hashes, one request about every 1.1 s; the browser sends only filters. civitai.com is the default site; civitai.red (all content) is a menu choice remembered per viewer. Civitai image hosts are accepted only on `civitai.com` and `civitai.red` (final host checked after redirects).
- Imports and restores never overwrite: settings backup imports add only, names already taken get "(imported)", an existing choice stays; an archive restore skips an image with the same seed and creation time.
- Hidden images are never archived (an archive folder is plain files); deleting everything needs the lock open when hidden images exist.
- Archiving is "move after a verified copy": every file is read back and hashed before anything leaves the gallery; any failure removes the half-written folder.
- Download later: an entry leaves the list by itself when a file with the same name, or a file Civitai identified as that very version, is in the library (a comparison in memory, no request); `wishlist:add` takes everything from main's cache of the last listing, never from the renderer.
- Stalled generations: only judged when the Forge reports a `job` name and was seen running the job; otherwise the old watchdog rules apply.
- The catalog hands out checkpoints without LoRA after 8 s and updates itself when the LoRA list arrives; the LoRA request itself waits up to 10 minutes.
- A model preview made from an image is dropped when that image is hidden; archiving and delete-all write one log entry, not one per image.
- Settings backup parts are chosen by the user at export and again at import; the Download later list travels without its preview images.
- Page zoom is off; dialogs sit below the 44 px top band (`--dialog-top`).
- Hires is optional in jobs and presets; switching it on requires a saved hires preset.

## Decisions taken during plan 1

Each was taken where the plan was silent or wrong; the user can reverse any of them.

- Job errors are stored as codes (`JobError`), not sentences; the UI maps them to catalog text.
- Rejected IPC calls carry a stable key (`IpcErrorKey`); the preload strips Electron's wrapper text.
- The operation log never stores Forge's error text for a generation (it can echo the prompt) — only kind and status. The text is shown on the job tile.
- Watchdog: 15 consecutive failed progress polls during a generation → the job is interrupted.
- Quitting waits at most 5 s for the queue to stop; a job still running is marked interrupted on the next start.
- Single app instance; `window.open` denied; navigation off the app's origin blocked; every field of a generation request validated at the IPC boundary, unknown keys dropped.
- Checkpoint-change log entries only when the checkpoint or modules differ from the previous finished job.
- `runner.stop()` is awaitable so the database is closed only after the queue stops.
- Schedulers are sent by label ("Automatic"), not internal name.
- Connection chip shows "No server" before an address is entered; the status is re-sent when the window reloads.
- A failed model-list load shows a notice with Retry.
- From the probe: modules are sent as full paths; shift is sent in `distilled_cfg_scale` (inferred from Forge's option names, not yet observed — verify); default modules per family come from Forge's own per-preset settings; the LoRA list gets a 60 s timeout and its failure no longer fails the model list; a checkpoint's family is detected from its title including folders (base name first).
- The user's real paths and model names are never committed.
- Process: the no-literals guard uses an AST parser (`@babel/parser`); small independent tasks were sometimes implemented and reviewed in pairs (8+9, 10+11).
- vitest runs with `globals: true`; work happens on `feature/core` in the main checkout (no separate worktree).
- After a generation fails with HTTP 500 the runner unloads the checkpoint (15 s timeout) before the next job; two 500s in a row raise an "unhealthy" notice. The app never restarts Forge by itself — only after the user confirms.
- Forge's error text for a failed job is kept on the job row and shown on the tile and in the log panel's job box; it is never copied into the operation log. Exported log files record only their file name.
- Model menu groups use `CheckpointInfo.family` (so later manual overrides apply), sorted by family then name.
- Extra Distilled CFG and Shift also became sliders (the user asked for Steps and CFG); Steps slider range 1..150.
- Saved servers are soft-deleted (`removed_at`) so finished jobs and images keep their server; deleting removes only queued jobs.
- Pulled forward from later plans at the user's request: image viewer, log panel (plan 2 Task 11), Restart Forge / Unload model (plan 3).

## Known minor follow-ups (not blocking)

Collected by reviewers and deferred; the final review triages them. The full list with file references is in the ledger. Notable ones:
- `fnc-img:` is allowed only in `img-src`; a future viewer that needs blobs must change the CSP.
- The module value is stored as a full path; if Forge ever expects names, `FINDINGS.modulesAs` drives it.
- The spec's 260 ms crossfade from a finished job's mosaic to its image (`--dur-reveal`) is in no plan-1 task; a finished job simply becomes an image tile. Carry into plan 2.
- Gallery tiles may change column when a job is added (greedy shortest-column layout); revisit with plan 2's virtualization. Each image tile is two tab stops (tile + Delete) — roving tabindex in plan 2.
- Gallery paging does not retry by itself after a failed page load while the sentinel stays in view.
- Verify hires stage detection (`job_no > 0`) on the real Forge.
- Spec item not done: an upscale result and its source shown as one tile.
- The resources monitor is keyed by server id, so it keeps history after a URL edit.
- Offline resource panel sparklines show stale samples.
- `REVEAL_MS` in ImageTile duplicates `--dur-reveal`.
- Kept on purpose: `hiddenImageAccess` and the `isBlocked` dep of `createImageHandler` (tests build on them; the index.ts stub is harmless).
- vitest sometimes prints "Timeout terminating forks worker" on this machine; all tests pass. Investigate in the final review.
- Server delete confirmation puts focus on the panel, not Keep. In the negative-preset Manage dialog, focus falls to the panel after an inline rename/keep/delete; the empty-state line in the preset menu is not announced; preset and server name limits are duplicated between main and renderer; the preset text-update IPC has no UI yet.
