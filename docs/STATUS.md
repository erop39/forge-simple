# Project status

Read this first in a new session. Keep it current: update it when a task finishes, a decision is
taken, or something starts waiting on the user.

## Where things stand

- Branch `feature/core` (local only, never pushed). `main` holds only the spec and plan docs.
- Plan 1 (core): `docs/superpowers/plans/2026-10-13-plan-1-core.md`.
- Startup prompt delay: fixed (committed with the servers work). The field now renders while the catalog loads and preserves early typing; see `docs/prompt-startup-fix.md` for cause, implementation, checks and the remaining catalog wait. A live-window check has not been done for this fix.
- Image viewer: implemented ahead of plan 2 (another session, reviewed and committed here). Click or Enter opens the full image, with saved job settings and Copy prompt below it. X closes the dialog; icons and Left/Right keys navigate the gallery, loading older pages as needed. The header reserves space for native Windows caption buttons. Checkpoint changes retain the selected width and height. See `docs/image-viewer.md` for the file map, behavior, checks and open work.
- Viewer verification on 2026-10-14: full suite (then 516 tests; 521 after the review fixes), typecheck and build passed before the mouse-click follow-up. A later physical-mouse check exposed that the arrows still sat in the top bar's draggable region; `.actions` now opts out with `-webkit-app-region: no-drag`. Physical Next and Previous clicks were reproduced failing before the CSS fix and confirmed working after it in an isolated Electron window against mock Forge. The selected 16:9 ratio also remained after a checkpoint switch in the earlier live run. Plan 2's remaining viewer actions and animation are still open.
- Review of that code: `docs/code-review-2026-10-14.md` — one server-switch gate, two async races and a PromptBar duplication. All four are fixed with tests (see its Resolution section).
- Plan 2 (gallery and library) is written in `docs/superpowers/plans/2026-10-14-plan-2-gallery.md`; the requested image-viewer slice was implemented ahead of its scheduled task. Other plan 2 features remain planned; the plan waits for the user's review before execution. Tasks outside the plans, from user requests: U1 (prompt bar fit, sliders, scrollable grouped menus) done; U2 (saved servers) done and reviewed, live two-server window check still to do; U3 (negative-prompt presets) next.

| Task | State |
|---|---|
| 1 Probe script | done; the user ran it on their Forge, findings applied (task "P") |
| 2–15 Scaffold → prompt bar and parameters panel | done, each reviewed |
| P Probe findings | done, reviewed |
| 16 Gallery (job and image tiles, delete with undo, paging) | done, reviewed |
| 17 End-to-end check and release 0.1.0 | e2e tests + README done and reviewed (4d1eac7). Open: manual walkthrough (only partly done), the user's real-Forge check, then release (CHANGELOG `[0.1.0]`, version, tag `v0.1.0`) |
| U1 Prompt bar fit, sliders, grouped scrollable menus | done, reviewed |
| U2 Saved servers list | done, reviewed; live two-server window check pending |
| U3 Negative-prompt presets | next (brief in the ledger) |
| Final whole-branch review | not started |

## How to resume

1. Read `CLAUDE.md`, then this file.
2. If `.superpowers/sdd/2026-10-13-plan-1-core/progress.md` exists, it is the detailed ledger (task briefs, review reports, every fix round). Resume at the first task without a `complete` line.
3. Without the ledger: use `git log` and the table above; regenerate a task brief with the subagent-driven-development `task-brief` script from the plan file.
4. After plan 1: review the written plan 2 (gallery features), write plan 3 (server tools, upscale) from the spec, then execute them the same way.

## Waiting on the user

- The mock-only temporary profiles used for viewer checks could not be deleted: automatic command review blocked cleanup. All test processes are stopped. The first profile is under the user's system temp directory; the physical-click check's profile is under the ignored `out/viewer-click-profile` directory.
- Real-Forge check in Task 17: one generation per model family over VPN, cancel mid-generation, drop the VPN mid-queue. It also confirms that shift really travels in `distilled_cfg_scale` (look for "Shift" in the image's infotext).
- Rest of the Task 17 manual walkthrough (on the mock or during the real-Forge session): cancel a waiting job, delete with Undo, images still there after restart, Tab order with visible focus, 1100×700 window, "Slow" state, animations, failed and interrupted tiles, native caption buttons. Already seen on 2026-10-14: connect, model pick, Ctrl+Enter with Images 2, live preview and progress, queued tile, finished tiles. The walkthrough stopped when someone at the desktop took over the test window and pointed it at the real Forge.
- That test window ran from a throwaway profile in the controller's temp scratchpad (it now holds real model names and images); close it and delete that profile when the user is done with it.
- Small UI issues seen in that window (Ctrl+Enter in the Negative field and the running-tile caption wrapping) were fixed after the walkthrough; they still need a live-window recheck.
- Before anything is pushed: commit `d84ab06` on this branch contains the user's real model names and paths (HEAD is clean). Offer to squash or rewrite the branch so they never leave the machine.

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

## Known minor follow-ups (not blocking)

Collected by reviewers and deferred; the final review triages them. The full list with file references is in the ledger. Notable ones:
- `images.source_image_id` has no `ON DELETE`; deleting a source image will fail once upscale exists (plan 3).
- `fnc-img:` is allowed only in `img-src`; a future viewer that needs blobs must change the CSP.
- The module value is stored as a full path; if Forge ever expects names, `FINDINGS.modulesAs` drives it.
- The spec's 260 ms crossfade from a finished job's mosaic to its image (`--dur-reveal`) is in no plan-1 task; a finished job simply becomes an image tile. Carry into plan 2.
- Gallery tiles may change column when a job is added (greedy shortest-column layout); revisit with plan 2's virtualization. Each image tile is two tab stops (tile + Delete) — roving tabindex in plan 2.
- Gallery paging does not retry by itself after a failed page load while the sentinel stays in view.
- vitest sometimes prints "Timeout terminating forks worker" on this machine; all tests pass. Investigate in the final review.
