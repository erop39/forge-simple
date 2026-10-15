# Guide for agents working on this repository

Forge Neo Client is an Electron + React + TypeScript desktop client for the Forge Neo image-generation
API. One user runs Forge Neo on a home PC and uses this app from other machines over a VPN or the LAN.
The repository is **public**: `https://github.com/erop39/forge-simple`.

This file is for any coding agent (Claude Code, Codex, others). Claude Code also loads `CLAUDE.md`,
which holds the full commands, layout and code rules; read it too — this guide does not repeat it.

## Read first, in this order

1. `docs/STATUS.md` — what is done, what is in progress, what waits on the user, every decision taken.
2. `CLAUDE.md` — commands, source layout, code rules, the manual-check procedure.
3. The plan you are executing, in `docs/superpowers/plans/` (plan 2 is in progress), and the spec
   `docs/superpowers/specs/2026-10-13-forge-neo-client-design.md` (the binding authority).

Talk to the user in Russian. Code, comments, commits, UI strings, README and CHANGELOG are English.

## What exists (summary; details in docs/STATUS.md and README.md)

- Core (plan 1): connection to Forge with status chip, model catalog with family detection
  (SDXL/Illustrious/Pony, Z-Image, Qwen, Lumina, Krea 2, Anima), txt2img with all parameters,
  an in-app queue, a gallery with live progress, SQLite storage, an operation log.
- Added on user request: prompt bar that fits at any width, sliders, scrollable grouped menus,
  saved servers with one-click switching, local Forge auto-detection, negative-prompt presets,
  image viewer, recovery from Forge HTTP 500s, Restart Forge / Unload model, operation-log panel,
  generation timestamps, mouse-wheel value stepping.
- Plan 2 (gallery and library): Task 1 tags and filtered queries, Task 2 hidden images behind a
  session lock, Task 11 log panel — done. Task 3 onward — see the table in `docs/STATUS.md`.

## How work is done here

- One task at a time, test first (vitest; `pnpm test`, one file `pnpm test <path>`).
- Before every commit: `pnpm build`, `pnpm typecheck`, `pnpm test` — all green. `pnpm build` is the
  only check that compiles CSS modules.
- Every user-visible change adds a line under `## [Unreleased]` in `CHANGELOG.md` and keeps
  `README.md` accurate, in the same commit.
- `CLAUDE.md` changes in the same commit as any new command, convention or layout change.
  `docs/STATUS.md` changes whenever a task finishes, a decision is taken, or something starts
  waiting on the user. A new chat on another PC must be able to continue from these two files alone.
- Every user-visible string goes through `t()` and `src/renderer/locales/en.ts` (a test enforces it).
- Errors cross process boundaries as codes (`JobError`, `IpcErrorKey`), never as sentences.
- Prompts, Forge error text and passwords never reach the operation log.
- Async state in `src/renderer/state/store.ts` carries revision counters so late responses never
  overwrite newer state — keep that pattern.
- Text with backslashes (Windows paths) is written with file-editing tools, not shell `sed`/`echo`
  or inline scripts: sequences such as backslash-f turn into control bytes. Check docs with
  `grep -nP '[\x00-\x08\x0B\x0C\x0E-\x1F]' *.md docs/*.md` (must print nothing).
- Never drive, reload or kill an app window you did not start. The user keeps their own window open.
  For manual checks use the mock (`pnpm mock-forge`), your own `--user-data-dir` under `out/`, and
  your own CDP port (see `CLAUDE.md`, "Manual check in the real window").
- The user's real Forge server: read-only requests only (GET). Never send generations, restart,
  unload, stop or kill to it unless the user asks in that conversation.

## Git

- Work branch: `feature/core`. `main` holds the spec and plans only; do not commit features to it.
  No merges to `main` without the user's go-ahead.
- Pull before starting work: `git pull --ff-only`. If it is not a fast-forward, stop and ask.
- Commit messages: imperative subject, optional `feat:` / `fix:` / `docs:` prefix as in the history,
  a body when the why is not obvious. Claude Code adds its `Co-Authored-By` line.
- The commit email must be the GitHub noreply address (`git config user.email` in this checkout).
  Never commit with a personal email.
- Never rewrite published history (`push --force`, rebase of pushed commits) without the user's
  explicit request.
- Do not commit: `node_modules/`, `out/`, `dist/`, `.superpowers/` (git-ignored task ledgers that may
  hold the user's server address), `tools/probe/probe-report.json` (the user's model names and paths),
  databases, generated images, `.env` or any credential file.

## Before every push

The repository is public. Nothing private may be published — not in files, not in old commits,
not in commit metadata.

1. Commit everything that belongs to the change; never push from the middle of a task.
2. Run the scanner on what is about to be pushed:
   ```
   node scripts/scan-private.mjs
   ```
   It checks the unpushed commits (diffs, messages, author and committer) for private LAN addresses,
   Windows user paths, personal emails, tokens and keys, credential assignments, tracked files that
   must not be published, and — when `tools/probe/probe-report.json` exists on this PC — the user's
   real model file names. `--all` checks the whole history.
3. If it reports anything: **do not push**. Show the hits to the user and decide with them. Invented
   test values that trip a pattern go into `scripts/scan-private.allow`, one exact substring per line,
   only after checking they are invented.
4. Push: `git push` (the branches track `origin`).
5. Note the push in `docs/STATUS.md` when it is a milestone.

Docs and tests use fictional names and addresses: `exampleMix_v10.safetensors`,
`http://100.x.y.z:7860`, `*.test` hosts. Never copy real values from the user's server, probe
report, database or screenshots into the repository.

## Working on a new PC

```
git clone https://github.com/erop39/forge-simple.git forge-neo-client
cd forge-neo-client
git checkout feature/core
pnpm install
git config user.email <the GitHub noreply address>
```

Keep the checkout outside OneDrive or other synced folders. Start the app with `pnpm dev`, or
`scripts/start-windows.cmd` when `pnpm` is not on the PATH. Each PC has its own servers, images and
log (Electron user data folder); they are not in the repository.

## Other documents

- `docs/forge-api-notes.md` — what the probe found about the real Forge API.
- `docs/image-viewer.md`, `docs/prompt-startup-fix.md`, `docs/code-review-2026-10-14.md` —
  handoff notes for earlier pieces of work.
