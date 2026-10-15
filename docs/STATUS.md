# Project status

Read this first in a new session. Keep it current: update it when a task finishes, a decision is
taken, or something starts waiting on the user.

## Where things stand

- Repository: `https://github.com/erop39/forge-simple` (public). Work branch `feature/core`; `main` holds only the spec and plan docs. Before the first push, commit `d84ab06` (it held the user's real Forge path and model names) was squashed with its fix, so no published commit carries them.
- Tests: 833 pass after plan 3 Task 3; build and typecheck pass. In an isolated Electron window with mock Forge, Send to img2img from saved image 2 attached the source and generated image 3. No mutating request went to the user's Forge.
- Agents: `AGENTS.md` is the guide for any agent (read order, what exists, working rules, git and push checklist). `node scripts/scan-private.mjs` checks unpushed commits for private data.
- Plan 1 (core): `docs/superpowers/plans/2026-10-13-plan-1-core.md`.
- Plan 3 (generation and server tools): `docs/superpowers/plans/2026-10-15-plan-3-generation-and-server-tools.md`. The user chose to pause plan 2 after Task 3's local commit and start plan 3 on 2026-10-15. Restart/Unload were already delivered as U4; plan 3 Task 1 (hires fix) is done, tested against mock Forge, and awaits a live-window check. No mutating request was sent to the user's Forge.
- Startup prompt delay: fixed (committed with the servers work). The field now renders while the catalog loads and preserves early typing; see `docs/prompt-startup-fix.md` for cause, implementation, checks and the remaining catalog wait. A live-window check has not been done for this fix.
- Image viewer: implemented ahead of plan 2 (another session, reviewed and committed here). Click or Enter opens the full image, with saved job settings and Copy prompt below it. X closes the dialog; icons and Left/Right keys navigate the gallery, loading older pages as needed. The header reserves space for native Windows caption buttons. Checkpoint changes retain the selected width and height. See `docs/image-viewer.md` for the file map, behavior, checks and open work.
- Viewer verification on 2026-10-14: full suite (then 516 tests; 521 after the review fixes), typecheck and build passed before the mouse-click follow-up. A later physical-mouse check exposed that the arrows still sat in the top bar's draggable region; `.actions` now opts out with `-webkit-app-region: no-drag`. Physical Next and Previous clicks were reproduced failing before the CSS fix and confirmed working after it in an isolated Electron window against mock Forge. The selected 16:9 ratio also remained after a checkpoint switch in the earlier live run. Plan 2's remaining viewer actions and animation are still open.
- Review of that code: `docs/code-review-2026-10-14.md` — one server-switch gate, two async races and a PromptBar duplication. All four are fixed with tests (see its Resolution section).
- Plan 2 (gallery and library) is written in `docs/superpowers/plans/2026-10-14-plan-2-gallery.md`; the requested image-viewer slice was implemented ahead of its scheduled task. Other plan 2 features remain planned; the user approved it on 2026-10-15 and it is being executed (subagent-driven; ledger in `.superpowers/sdd/2026-10-14-plan-2-gallery/`, local only). Tasks outside the plans, from user requests: U1 (prompt bar fit, sliders, scrollable grouped menus) done; U2 (saved servers) done, reviewed and checked live with two mock servers; U3 (negative-prompt presets) done, reviewed and checked live; U4 (Forge 500 recovery, Restart Forge / Unload model, operation-log panel = plan 2 Task 11, generation timestamps, mouse-wheel stepping) done and reviewed (one fix round), checked live on the mock only.

| Task | State |
|---|---|
| 1 Probe script | done; the user ran it on their Forge, findings applied (task "P") |
| 2–15 Scaffold → prompt bar and parameters panel | done, each reviewed |
| P Probe findings | done, reviewed |
| 16 Gallery (job and image tiles, delete with undo, paging) | done, reviewed |
| 17 End-to-end check and release 0.1.0 | e2e tests + README done and reviewed (4d1eac7). Open: manual walkthrough (only partly done), the user's real-Forge check, then release (CHANGELOG `[0.1.0]`, version, tag `v0.1.0`) |
| U1 Prompt bar fit, sliders, grouped scrollable menus | done, reviewed |
| U2 Saved servers list | done, reviewed, checked live |
| U3 Negative-prompt presets | done, reviewed, checked live |
| U4 500 recovery, Restart/Unload Forge, log panel, timestamps, wheel stepping | done, reviewed; live check on the mock only |
| U5 Keep negative across server switch; local Forge by default | done, reviewed |
| Plan 2 Task 1 Tags and filtered image queries (storage) | done, reviewed |
| Plan 2 Task 2 Hidden images behind a session lock | done, reviewed (one fix round: no prompt leak via jobs:get while locked, wrong-password lockout 5 failures → 30 s) |
| Plan 2 Task 3 Virtualized gallery, keyboard, crossfade | in progress |
| Plan 2 Tasks 4–10, 12 | not started |
| Plan 2 Task 11 Log panel | done earlier as U4 |
| Plan 3 Task 1 Hires fix | done; payload, IPC, second-pass progress, panel and viewer covered by tests; live-window check pending |
| Plan 3 Task 2 Img2img request and queued job | done, reviewed and tested |
| Plan 3 Task 3 Img2img entry points | done; viewer action, saved-gallery drag, mode/source and controls; checked in an isolated window against mock Forge. External file drops are not supported. |
| Plan 3 Tasks 4–10 | not started |
| Final whole-branch review | not started |

## How to resume

1. Read `CLAUDE.md`, then this file.
2. On a new PC: clone `https://github.com/erop39/forge-simple`, `git checkout feature/core`, `pnpm install` (see README). Pull before you start, push when a task is done — after the private-data scan described in `CLAUDE.md`.
3. The detailed ledger (`.superpowers/sdd/2026-10-13-plan-1-core/progress.md`, task briefs, review reports) exists only on the PC that wrote it (git-ignored). If it is there, it has every fix round; if not, this file and `git log` are the record — the decisions below are complete. Regenerate a task brief from the plan file with the subagent-driven-development `task-brief` script.
4. Continue plan 3 Task 4 (upscale finished image); plan 2 is paused after Task 3's local commit. The real-Forge check and release work from plan 1 remain separate.

## Waiting on the user

- The user chose plan 3 next on 2026-10-15. The real-Forge check below and release 0.1.0 are deferred until the user returns to them; no real-server generation is authorized by this decision.
- Leftover throwaway test profiles from viewer checks (mock data only) may sit in the system temp folder and in the ignored `out/viewer-click-profile`; safe to delete.
- The user's real Forge now runs with `--api-server-stop` (restart from the app is enabled). After a failed checkpoint load (500 `AttributeError`) it returned 500 `TypeError` for every model until restarted; the app now unloads after a 500 and offers a restart.
- Real-Forge check in Task 17: one generation per model family over VPN, cancel mid-generation, drop the VPN mid-queue. It also confirms that shift really travels in `distilled_cfg_scale` (look for "Shift" in the image's infotext).
- Rest of the Task 17 manual walkthrough (on the mock or during the real-Forge session): cancel a waiting job, delete with Undo, images still there after restart, Tab order with visible focus, 1100×700 window, "Slow" state, animations, failed and interrupted tiles, native caption buttons. Already seen on 2026-10-14: connect, model pick, Ctrl+Enter with Images 2, live preview and progress, queued tile, finished tiles. The walkthrough stopped when someone at the desktop took over the test window and pointed it at the real Forge.
- Small UI issues seen in that window (Ctrl+Enter in the Negative field and the running-tile caption wrapping) were fixed after the walkthrough; they still need a live-window recheck.

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
- `images.source_image_id` has no `ON DELETE`; deleting a source image will fail once upscale exists (plan 3).
- `fnc-img:` is allowed only in `img-src`; a future viewer that needs blobs must change the CSP.
- The module value is stored as a full path; if Forge ever expects names, `FINDINGS.modulesAs` drives it.
- The spec's 260 ms crossfade from a finished job's mosaic to its image (`--dur-reveal`) is in no plan-1 task; a finished job simply becomes an image tile. Carry into plan 2.
- Gallery tiles may change column when a job is added (greedy shortest-column layout); revisit with plan 2's virtualization. Each image tile is two tab stops (tile + Delete) — roving tabindex in plan 2.
- Gallery paging does not retry by itself after a failed page load while the sentinel stays in view.
- vitest sometimes prints "Timeout terminating forks worker" on this machine; all tests pass. Investigate in the final review.
- Server delete confirmation puts focus on the panel, not Keep. In the negative-preset Manage dialog, focus falls to the panel after an inline rename/keep/delete; the empty-state line in the preset menu is not announced; preset and server name limits are duplicated between main and renderer; the preset text-update IPC has no UI yet.
