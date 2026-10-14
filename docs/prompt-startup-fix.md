# Prompt field at startup — handoff (2026-10-14)

## Problem and cause

The prompt field used to appear only after the model catalog loaded. `App` rendered `PromptBar` immediately, but `PromptBar` returned `null` whenever either `params` or `catalog` was `null`. Both start as `null` in the renderer store. During initialization, the store reads settings, jobs and images, then requests the catalog and the initial checkpoint defaults.

The catalog request waits for all Forge lists in one `Promise.all`, including `/sdapi/v1/loras`. A previous probe of the user's Forge showed that this endpoint exceeded the old 10-second list timeout, so it was given a separate 60-second timeout. That makes slow LoRA enumeration a plausible major contributor to the visible delay. The current live server was not timed during this fix; other catalog requests or initial IPC calls can also contribute.

## Implemented behavior

- `src/renderer/components/PromptBar.tsx` renders the prompt textarea even when `params` or `catalog` is missing. While the catalog is loading, it shows `Loading models…` and a disabled Generate button. Model-dependent controls appear when the first checkpoint's parameters are ready. If loading fails or there are no checkpoints, the existing notice or empty state explains the problem without a duplicate status line.
- `src/renderer/state/store.ts` has `draftPrompt`. `setParams({ prompt })` updates this draft while `params` is absent. `useCheckpoint` copies it into the first model's parameters after `catalog.defaults` resolves. Once parameters exist, prompt edits keep both values in sync. This also preserves the text if a server change temporarily clears `params`.
- `src/renderer/locales/en.ts` contains the new loading text; `PromptBar.module.css` styles it with existing design tokens.
- The waiting and ready versions of the textarea keep the same DOM node and focus when controls appear. Ctrl+Enter cannot generate until parameters exist.
- `README.md` and `CHANGELOG.md` describe the user-visible change.

## Checks performed

- The new tests failed before the fix: the textarea was absent before catalog load, and an early prompt was discarded by the store.
- `src/renderer/components/PromptBar.test.tsx` now checks immediate rendering, early typing, disabled Generate, and preservation of the textarea node and focus when the model becomes ready.
- `src/renderer/state/store.test.ts` holds the catalog response pending and checks that the early draft reaches the initial checkpoint parameters.
- Focused PromptBar, store and App tests: 71 passed. After the final keyboard-handler change, the full suite passed again: 510 tests in 36 files. Typecheck and production build passed. Vitest printed its known worker-termination warnings, but exited successfully.
- The result has **not** been observed in a live Electron window or retested against the user's Forge.

## Remaining boundary

Committed with the saved-servers work on 2026-10-14. This fix makes the **input field** available immediately. Model selection and Generate still wait for the full catalog, including the optional LoRA list. If the delay to a usable Generate button is the next problem, separate LoRA loading from the catalog's critical path and update the renderer when that list arrives; do not shorten its timeout blindly, because the user's large LoRA library has already exceeded 10 seconds.

For a manual check, launch a new Electron window with a disposable `--user-data-dir` and a mock Forge whose LoRA endpoint is slow. Confirm that the textarea is available and retains text while Generate is disabled, then that the text and focus remain when controls arrive. Follow the window-ownership precautions in `CLAUDE.md`; do not drive an existing user window.
