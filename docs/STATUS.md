# Project status

Read this first in a new session. Keep it current: update it when a task finishes, a decision is
taken, or something starts waiting on the user.

## Where things stand

- Branch `feature/core` (local only, never pushed). `main` holds only the spec and plan docs.
- Plan 1 (core): `docs/superpowers/plans/2026-10-13-plan-1-core.md`.

| Task | State |
|---|---|
| 1 Probe script | done; the user ran it on their Forge, findings applied (task "P") |
| 2–15 Scaffold → prompt bar and parameters panel | done, each reviewed |
| P Probe findings | done, reviewed |
| 16 Gallery (job and image tiles, delete with undo, paging) | done, reviewed |
| 17 End-to-end check and release 0.1.0 | not started |
| Final whole-branch review | not started |

## How to resume

1. Read `CLAUDE.md`, then this file.
2. If `.superpowers/sdd/2026-10-13-plan-1-core/progress.md` exists, it is the detailed ledger (task briefs, review reports, every fix round). Resume at the first task without a `complete` line.
3. Without the ledger: use `git log` and the table above; regenerate a task brief with the subagent-driven-development `task-brief` script from the plan file.
4. After plan 1: write plan 2 (gallery features) and plan 3 (server tools, upscale) with superpowers:writing-plans from the spec, then execute them the same way.

## Waiting on the user

- Real-Forge check in Task 17: one generation per model family over VPN, cancel mid-generation, drop the VPN mid-queue. It also confirms that shift really travels in `distilled_cfg_scale` (look for "Shift" in the image's infotext).
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
