# Ready-code review — 2026-10-14

## Scope

Read-only review of the uncommitted image viewer, startup prompt field, checkpoint selection and their integration with the in-progress saved-server work. The baseline was `HEAD` (`d33ee24`); this was not a full audit of all Plan 1 code. Findings below follow from code paths and were not reproduced as separate runtime failures. The server-list feature is still in progress; its finding is a release gate for that feature, not a claim that it was marked complete.

## Findings

### P1 — Server switch leaves the previous model selectable and submittable

In `src/renderer/state/store.ts`, `syncServers()` sets the new `settings` and `servers` at line 138, then awaits `loadCatalog()` without first invalidating the old `catalog` and `params`. `PromptBar` can therefore keep Generate enabled while the next server's catalog loads. `generate()` at line 263 submits those old parameters, while `jobs:enqueue` in `src/main/ipc/register.ts` selects the currently active server. A job for the former server's checkpoint can be queued on the new server.

Clear or disable server-scoped catalog and parameters as one state transition when the active address changes. Preserve the prompt in `draftPrompt`. Bind the subsequent catalog response to the server transition so a late response from an earlier server cannot restore stale data. Add a deferred-catalog test that switches servers, attempts to generate before the new catalog resolves, and resolves the old response last.

### P2 — Older checkpoint requests can overwrite a newer choice

`useCheckpoint()` in `src/renderer/state/store.ts` (lines 93–103) awaits `api.catalog.defaults(title)` and then unconditionally writes `params`. If the user selects checkpoint A and then B, and A resolves after B, the final selected checkpoint becomes A. The same missing request ownership affects a catalog load that overlaps another selection.

Use a monotonically increasing selection/request revision (or an equivalent current-title check) before committing asynchronous defaults and parts. Test two deferred responses resolving in reverse order; assert that the last user choice wins.

### P2 — Copy confirmation can belong to the previous image

`copyPrompt()` in `src/renderer/components/ImageViewer.tsx` (lines 78–85) updates `copyState` after the clipboard IPC promise settles. Navigation resets that state in an effect, but a pending copy from image A can settle after image B opens and mark B as copied (or failed). The copied clipboard text would still be A's prompt.

Capture the image ID for the copy operation and ignore completion when the viewer has moved to another image or closed. Cover this with a deferred clipboard promise and navigation before resolution.

### P2 — Prompt bar has two render trees for one editor

`src/renderer/components/PromptBar.tsx` renders separate loading and ready branches (starting at lines 116 and 175). Both contain the prompt field, row and Generate control. The current test confirms that focus survives the transition, but future changes to this shared UI must be duplicated and kept in sync.

Keep one outer bar and one `GrowingField`; conditionally render only model-dependent controls and the loading state. Preserve the existing focus-continuity test while restructuring.

## Verification and limits

- Current working tree: 36 test files, 516 tests passed; TypeScript checks passed on 2026-10-14.
- `git diff --check` reported no whitespace errors. The production build and physical Windows mouse check for both viewer arrows passed in the preceding fix; the build was not rerun specifically for this read-only review.
- No source files were changed during the review. The findings are based on the inspected code paths; runtime reproductions and focused regression tests remain to be done when fixing them.

## Resolution (2026-10-14)

All four findings were fixed before the work was committed:

- **P1** — `syncServers()` in `store.ts` clears catalog, params and parts in one update and bumps `partsSeq`, `selectSeq` and `catalogSeq`; the prompt moves to `draftPrompt`; the new catalog loads in the background. Test: store.test.ts "a server switch drops the old params at once, keeps the prompt, and a late old response cannot win".
- **P2 checkpoint race** — `useCheckpoint()` takes a `selectSeq` revision and drops older responses, including failures. Tests: "the last checkpoint choice wins when an older defaults response resolves later", "a superseded checkpoint choice that fails does not report an error".
- **P2 copy race** — `ImageViewer` records the copied image id and ignores completion after navigation or close. Test: Gallery.test.tsx "a copy that settles after moving to another image does not mark that image as copied".
- **P2 PromptBar** — one bar and one `GrowingField`; only the model controls are conditional. The focus-continuity test still passes.
