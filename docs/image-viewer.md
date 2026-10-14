# Image viewer handoff

Implemented on 2026-10-14 from the user's request to enlarge an image on click and show its prompt and generation settings below it.

## What works

- Clicking a finished gallery image or focusing it and pressing Enter opens a full-window Radix dialog. It displays the image's `url` (the saved full PNG), rather than `thumbUrl`. Escape or the X icon returns focus to the opening tile.
- The previous and next arrow icons, or Left/Right keys, traverse visible images in gallery order (newest to oldest). At the oldest loaded image, Next calls the existing image-page loader and advances when an older image arrives. Buttons disable at the ends. The position indicator counts currently loaded images.
- The lower scrollable panel shows the saved positive prompt, an optional negative prompt, model, scheduler, sampler, steps, image size, actual image seed, guidance values relevant to the model family, generation time and enabled LoRAs. The panel stays below the image in a small window.
- Copy prompt copies the exact saved positive prompt through Electron's clipboard. Success and failure are visible in the dialog. Prompts are not written to the operation log.
- A deleted or missing image reports `error.notFound`. Damaged persisted job settings report `error.invalidParams` instead of crashing the renderer.

## Data path

`Gallery` holds the selected `ImageRecord` and opening button. `ImageTile` has a separate open button and Delete button. `ImageViewer` requests `window.api.images.details(id)` when opened. The IPC handler in `src/main/ipc/register.ts` reads `repos.images.get(id)` and `repos.jobs.get(row.jobId)`, checks the saved params and returns `{ image, params, jobType }`. The image is converted to `fnc-img://`; filesystem paths stay in main. `clipboard:writeText` also goes through preload and main.

| File | Responsibility |
|---|---|
| `src/renderer/components/Gallery.tsx` | Selects an image, keeps gallery order and loads older pages for Next. |
| `src/renderer/components/ImageTile.tsx` | Opens the viewer separately from the tile's Delete action. |
| `src/renderer/components/ImageViewer.tsx` and `.module.css` | Dialog, full-size image, metadata, copy, navigation and close controls. |
| `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc/register.ts` | Typed image-details and clipboard channels, saved-job lookup and parameter validation. |
| `src/renderer/styles/tokens.css` and `src/renderer/components/TopBar.module.css` | Shared 140 px reservation for native Windows caption controls. |
| `src/renderer/state/store.ts` | Preserves width and height when the selected checkpoint changes. |

The viewer header and top bar both reserve `--w-caption-controls` at the right. Electron's native Windows title-bar buttons cover this region: placing interactive HTML there made the viewer's X and arrows visible but unclickable in a real window. The X now calls `onClose` directly from an icon-only button. The previous `Dialog.Close asChild` through `IconButton`/Tooltip was removed. Keyboard arrows are listened for while the dialog is mounted, so a disabled navigation button cannot strand keyboard focus.

The underlying `TopBar` is also an Electron drag region. Reserving caption-button width did not make the arrows physically clickable: their screen coordinates still overlapped the underlying drag region. DevTools mouse dispatch and jsdom clicks reached the React handler, while Windows mouse clicks did not; X happened to overlap the top bar's own `no-drag` setting control and worked. `ImageViewer.module.css` now marks `.actions` as `-webkit-app-region: no-drag`. Keep this rule when moving viewer controls. A physical Windows mouse check must cover both arrows, because DevTools clicks alone missed this regression.

`state/store.ts` carries the current `width` and `height` into the next checkpoint's parameter set. Initial model selection still uses the model family's defaults. This keeps both preset ratios and custom dimensions when switching checkpoints.

The renderer does not derive settings from Forge infotext. This keeps prompts available from the original saved job after a restart and avoids parsing server-specific infotext.

The counter includes only images currently loaded into the gallery, not every image in the database. If loading an older page fails, the viewer stays on the current image and the store reports the error through the existing notice flow.

## Verification and remaining plan work

Tests cover opening by keyboard, separate Delete activation, full-image URL, saved settings, copy and focus restoration, IPC validation, and no clipboard prompt in the operation log. Follow-up tests cover X clicking, icon presence, both navigation directions, keyboard arrows, older-page loading and ratio preservation. On 2026-10-14 the full suite passed (516 tests), as did typecheck and build before the drag-region follow-up. The first live Electron check used DevTools mouse dispatch and confirmed X, navigation and a selected 16:9 ratio after changing from SDXL to Krea 2. A second isolated Electron check reproduced the arrow failure with physical Windows mouse input, then confirmed physical Next and Previous clicks after the CSS fix; the production build and 14 gallery tests passed. The test processes were stopped. Automatic command review blocked cleanup of both throwaway profiles; the second is in the ignored `out/viewer-click-profile` directory. On this machine, invoke pnpm through its Node entrypoint if the PowerShell shim returns without running.

Plan 2 Task 5 also proposes Reuse settings, Save as, Hide/Delete inside the viewer, and an expansion animation. Those remain to implement. Plan 2's hidden-image lock is also not present yet; when added, `images:details` must apply its authorization check before returning params.
