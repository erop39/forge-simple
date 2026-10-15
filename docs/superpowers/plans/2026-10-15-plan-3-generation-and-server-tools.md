# Forge Neo Client — plan 3: generation and server tools

**Authority:** `docs/superpowers/specs/2026-10-13-forge-neo-client-design.md`, sections 4–8 and 13–15. Execute on `feature/core`, one task at a time, tests first. Each task ends with build, typecheck, full tests, README, CHANGELOG and STATUS updates. Use only mock Forge for mutating manual checks; the user's Forge is read-only unless they request otherwise.

**Scope:** hires fix, img2img without masks, upscaling finished images, resource monitoring and optional read-only Forge extension, export/import, image-folder configuration. Restart Forge and Unload model were delivered as U4 and are not repeated. Plan 2 gallery, tags, presets and checkpoint UI can advance independently; use their interfaces when available, without changing unfinished plan 2 work here.

## Tasks

### 1. Hires fix in txt2img

Add typed settings, defaults, IPC validation and a pure payload mapping for Off / 1.5× / 2× / 4×, upscaler, second-pass steps and denoising strength. Show controls and computed target size in the parameters panel. An Off request omits hires fields. Test rejected values, request bodies, retained defaults and panel interaction. Verify a job end to end against mock Forge, including the saved image dimensions.

### 2. Img2img request and queued job

Add the Forge client endpoint, typed source image and denoising/resize settings, IPC validation, and runner dispatch by job type. Read source image only from the app's image store; enforce the session lock for hidden images. Test request mapping, corrupt/missing/locked sources, cancellation, interrupted jobs and mock responses. No mask or inpaint.

### 3. Img2img entry points

Add Send to img2img in the viewer and image drop on the prompt bar. Show the source and mode; allow removing it. Preserve prompt and useful settings when switching modes, and prevent an accidental txt2img request with an attached image. Test UI and keyboard behavior; check the flow in an isolated app window with mock Forge.

### 4. Upscale finished image

Add `/extra-single-image`, a queued `upscale` job, source reference, upscaler and scale validation, and persistence of the result with `source_image_id`. Add settings for the default upscaler for hires fix and finished-image upscale. Resolve source deletion behavior before the foreign key is used. Test the client, queue and image lineage against mock Forge, including failures and cancellation.

### 5. Upscale viewer

Add the viewer action and a before/after control for completed upscale pairs. Respect the hidden-image lock and gallery selection. Test keyboard and pointer interaction and verify visually in an isolated app window.

### 6. Read-only resource monitor

Parse `/memory`, collect 60 in-memory samples and poll only while the window is visible (2 s idle, 1 s during generation). Associate peak VRAM with a job. Keep polling failures separate from the generation queue. Test parsing, cadence, stale responses, server switches and absent fields.

### 7. Optional Forge stats extension and resource UI

Add a read-only extension under `forge-extension/` for CPU, RAM and GPU metrics with null fallbacks. Probe it once on connection; use `/memory` when absent. Show top-bar values and a one-minute detail panel with threshold indicators and version information. Keep existing Restart/Unload controls accessible. Test fallback and connection-state transitions; document manual installation.

### 8. Versioned settings export/import

Export presets, server names/addresses, checkpoint-family overrides, LoRA trigger edits and settings to one versioned JSON file; exclude images, jobs, tags, log and lock hash. Validate the entire file before a transactional additive import; resolve name collisions with `(imported)`. Show an import preview. Test round-trip, conflicts, malformed data and unknown versions.

### 9. Image storage location

Allow choosing the location for future images in settings. Keep existing images readable at their original paths and prevent path traversal or deletion outside managed folders. Test storage resolution, restart persistence, missing volumes and a failed write. Explain backup and moving existing images in README.

### 10. Integration and release readiness

Run mock end-to-end flows for hires, img2img and upscale and a manual walkthrough in an isolated window. Complete pending plan 1/2 release checks separately; do not tag a release or run mutating checks on the user's Forge without the user's go-ahead.

## Key dependencies and risks

- Task 3 needs Task 2; Task 5 needs Task 4. Task 7 needs Task 6. Task 8 should use plan 2's final preset and metadata schema once those land.
- `GenerationParams` is persisted as JSON. New optional fields must be normalized for old jobs and validated at the IPC boundary before requests reach Forge.
- The mock currently returns fixed-size images; teach it hires/img2img/upscale behavior so tests verify the resulting dimensions rather than only the outgoing JSON.
- Exported server addresses can be private. The export is user data, never a repository fixture or log entry.
