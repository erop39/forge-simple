# Whole-project code review, 2026-10-16

Three read-only reviews on Opus (commit `8272a1d`, tag `ckpt-20261016-28`), split by area: A = main-process IPC, security and data;
B = Forge communication, queue and generation; C = renderer. Findings are the reviewers' claims, each checked by them against
the code but **not yet reproduced by us**; verify before fixing. Status column: open until a commit fixes it.

## Progress

Fixed on 2026-10-16, each reproduced by a test first: C1, C2, C3, A1, A2, B1, B2, B6.
**Still open (do these next, in this order): B3, B4, B5**, then triage the Minor list (fix or move to the backlog in `docs/ROADMAP.md`).
Hints: B4 and B5 are both in `src/main/forge/catalog.ts` (store the fetch seq together with the cached catalog; bind the server id when a fetch starts, drop late results of a replaced catalog; `noteSeen` in `src/main/index.ts` uses the active server at call time). B3 is in `src/main/queue/runner.ts` (`checkParts` while `catalog.lorasLoading`: pause the job instead of failing it).

## Critical

| # | Area | Finding | Where | Status |
|---|---|---|---|---|
| C1 | Renderer | "Send to hires" without a catalog (Forge offline or still loading) crashes the whole window: a selector returns a new `[]` every call, so React loops ("Maximum update depth exceeded"); there is no ErrorBoundary. The same array in the effect deps refetches details and resets the hires settings being edited when the catalog is replaced. | `HiresDialog.tsx:38,60` | fixed (test first; plus a top-level ErrorBoundary) |

## Important

| # | Area | Finding | Where | Status |
|---|---|---|---|---|
| B1 | Queue | The stall detector can throw away a finished image: on a slow VPN link Forge reports idle (`job` '') while the large response is still downloading; after 45 s the job is aborted as `stalled`. Fix: stop judging once response headers arrived. | `runner.ts:428-437` | fixed (test first; client reports response headers, the stall detector stops judging then) |
| B2 | Client | Undici's default 300 s headers timeout cuts every generation slower than 5 minutes (classified as `network`; Forge keeps generating). `EXTRAS_TIMEOUT_MS` and the 600 s LoRA timeout are unreachable. Fix: a dispatcher with `headersTimeout: 0, bodyTimeout: 0` for generation and LoRA requests. | `client.ts:246` | fixed (test first; undici long-request agent, new dependency) |
| B3 | Queue/catalog | Queued jobs with LoRA fail permanently as `missingParts` while the LoRA list is still loading (`lorasLoading: true`, no LoRA). Fix: pause (or skip the LoRA check) while it loads. | `runner.ts:284-291`, `catalog.ts` | open |
| B4 | Catalog | A late LoRA list can be applied to the previous cached catalog and then `lorasLoading` stays true forever (microtask order against `cached = c`). Fix: store the fetch seq with the cached catalog. | `catalog.ts:167-178,236,264` | open |
| B5 | Catalog | After a server switch the old server's late LoRA list (and a late `noteSeen`) is recorded under the new server: phantom `model_meta` rows, wrong "recently added", spurious `catalog:updated`. Fix: bind the server id when the fetch starts, or drop late results from a replaced catalog. | `catalog.ts:157-160,236`, `index.ts:142-145` | open |
| B6 | Families | `detectFamily` matches `anima` inside `animagine…`, `animal…`, `animation…` (and `lumina` inside `illuminati…`): popular SDXL checkpoints get the anima profile. Fix: match whole tokens. | `shared/profiles.ts:61` | fixed (test first; whole-word matching) |
| A1 | Lock | Hiding an image does not hide its upscaled copies (they carry its infotext and show the same picture) nor img2img results made earlier. Fix: hide descendants too (or warn). | `register.ts:1092-1109`, `repos.ts:428` | fixed (test first; hiding also hides descendants) |
| A2 | Archive | A failure after the gallery removal has started (e.g. SQLITE_BUSY) wipes the verified archive folder, losing the images already removed. Fix: end the cleanup scope right after `repos.archives.add`; removal errors only count as `notRemoved`. | `archive.ts:128-138` | fixed (test first) |
| C2 | Renderer | The archive dialog lives inside `SelectionBar`, which unmounts when `image:removed` events empty the selection, so the result (or a late error) is never shown. Fix: lift the dialog out and snapshot the ids. | `SelectionBar.tsx:40`, `Gallery.tsx:361` | fixed (test first; dialog now lives in App) |
| C3 | Renderer | `image:removed` returns fresh arrays for every event even when the image is not loaded: delete-all or a big archive re-lays out the gallery once per image. Fix: ignore unknown ids; ideally a batched event. | `store.ts:478` | fixed (test first) |

## Minor

Area A:
- A3 Hiding during an archive run still lets the image out (visibility decided once at the start). Re-check per image or refuse `setHidden` while archiving. `archive.ts:64-66`
- A4 Restore is not atomic per image: the job is inserted before `saveImage`, a failure leaves an orphan done job (inflates "uses"); no size caps on archive file reads. `archive.ts:151,200-218`
- A5 File paths reach the operation log (`log.storage.fileRemoveFailed` stores full paths and `err.message`). Log the base name and error code only. `register.ts:1131-1135`
- A6 Server-switch races (id captured before an await): previews (`previews.ts:73-127`), `models:setPreviewFromImage` (`register.ts:943-960`), `civitai:updateOne` (`:756-773`), `servers:update` (`:496-517`).
- A7 A custom preview made from a hidden image stays on disk for a non-active server, and the cleanup also clears a newer custom preview from another image. `register.ts:930-936`
- A8 Civitai preview fetch: redirect host not checked, whole body buffered before the size check (also `fetchThumb`). `previews.ts:110-122`, `civitai.ts:196-199`

Area B:
- B7 A persistent catalog error loops every 5 s, piling up `/loras` requests and log entries. Back off and abort the LoRA request. `runner.ts:268-273`
- B8 Restarting the new server kills a job running on the old one. `runner.ts:663-666`
- B9 Cancel during image save is silently ignored (`active = null` before `finish`). `runner.ts:470`
- B10 A stale ping can be emitted as the new server's status; add a reset on server switch. `connection.ts:95-100`
- B11 Main-thread work every 1–2 s: `listActive()` parses every failed job; usage queries on every catalog read. `index.ts:169-172`
- B12 The stats extension route bypasses `--api-auth`. `forge_neo_client_stats.py:134`
- B13 Mock Forge: `/progress` has no `state.job`; `requests` grows without bound. `tools/mock-forge/server.ts`
- B14 (unverified, worth one probe) For the shift families the hires pass sends no `hr_distilled_cfg`; if Forge uses it as the second-pass shift, the second pass runs with the API default. `payload.ts:49-52`

Area C:
- C4 A model preview that failed once never reloads (not keyed by url). `ModelGallery.tsx:337-348`
- C5 "View image" requests are dropped when the image is not in the loaded or focused set. `Gallery.tsx:174-183`
- C6 Viewer "Next" pages through hidden data in focus mode. `Gallery.tsx:149,194`
- C7 Importing settings reloads the catalog and re-selects the checkpoint, replacing the user's current parameters. `store.ts:863-869`
- C8 Escape inside an inner input closes the whole dialog (Radix capture-phase listener). `TagEditor.tsx:60`, `PresetMenu.tsx:133`
- C9 `setCheckpointFamily` can reject with no message. `store.ts:1228`
- C10 Every log row re-renders on every image event. `LogPanel.tsx:94`
- C11 Every base-model tick sends a Civitai request (429 risk); debounce or apply on menu close. `CivitaiBrowser.tsx:89-94`
- C12 Result messages omit what failed or was skipped (archive `unreadable/notRemoved/skippedHidden`, delete-all `failed`, hidden count in the confirmation). `SelectionBar.tsx:77`, `ServerDialog.tsx:228,244`
- C13 Display text outside `t()` (the Z-Image labels, KB/MB/GB units, the `label (n)` composition) and an orphaned comment. `CivitaiBrowser.tsx:23`, `format.ts`, `ModelGallery.tsx:207-212`
- C14 Accessibility: model card `aria-label` hides its chips, the side panel is labelled "File", comboboxes lack `aria-activedescendant`. `ModelGallery.tsx:278,303`, `SearchField.tsx`, `TagEditor.tsx`

## Verdicts

- A: no critical issues; fix A1 and A2 before the next release.
- B: needs fixes before release; B1–B3 lose or fail real generations in the target VPN setup, B4–B5 corrupt catalog state.
- C: not ready as is; fix C1 and C2 first, then C3.
- No violations of the colour, weight, uppercase or animation rules; no untrusted HTML is rendered; SQL is parameterised; IPC validation and lock checks are otherwise solid.
