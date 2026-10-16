# Roadmap

What is planned for the versions after 0.2.0, in order. Dates are not promised: a version ships when its exit
criteria are met and the user has seen it. `docs/STATUS.md` is the live state (what is done, what waits on the
user); this file is the plan. Changing the order is the user's call.

## Released

| Version | Date | What it is |
|---|---|---|
| 0.1.0 | 2026-10-15 | Core: servers, catalog and families, txt2img, queue, gallery, hidden images, log, hires, img2img, upscale, resource monitor |
| 0.2.0 | 2026-10-16 | Model library (checkpoints and LoRA, previews, marks, duplicates, Civitai lookup), search and tags, selection, settings presets, family defaults |

## 0.3.0 — Library, archive and Civitai browser (built, waiting for its release pass)

Everything below is already in `[Unreleased]` in `CHANGELOG.md`:

- Civitai browser: new models by type, one or several base models, name and period; civitai.com or civitai.red; Download later list with automatic removal; Back button.
- Archives, phase 1: archive the selection with a verified copy, list, restore a whole archive. Delete all generations (red button).
- Settings backup with a choice of parts (servers, presets, hires and negative presets, model marks, settings, Download later).
- Focused gallery view (only the latest request).
- Long-job safety: stalled generations are given up after 45 s of an idle Forge; the start no longer waits for a slow LoRA list; the tile warns when nothing moves.
- Lime "Newer version" chip, icons on Download later cards.

Exit criteria (the release pass):

0. The Critical and Important findings of `docs/code-review-2026-10-16.md` are fixed (the minor ones are triaged into the backlog or fixed).
1. One walk through the real window on the user's PC: archive and restore with real files, settings export and import with the native file dialogs, the Civitai browser on both sites, Download later, focused view, caption buttons clear of every dialog, the Slow connection state, animations.
2. A whole-branch review of the changes since `v0.2.0` (same procedure as for 0.2.0), findings of Critical/Important fixed.
3. `CHANGELOG.md` `[0.3.0]`, version bump, tag `v0.3.0`, pushed.

## 0.4.0 — Local prompt assistant (design: `docs/prompt-assistant-design.md`)

Plan outline: `docs/superpowers/plans/2026-10-16-plan-4-prompt-assistant.md`. Starts when the user answers the six
questions at the end of the design document.

- Settings for a local OpenAI-compatible endpoint (Ollama, LM Studio or llama.cpp), with a Test button.
- Prompt profiles per family (tags, natural language, mixed), built in and editable, part of the settings backup.
- Idea → prompt (Russian in, English out), three variants to choose from, the family's default negative proposed, LoRA trigger words added.
- Image → prompt from the viewer and by dropping an image on the prompt bar, two-stage mode for small models.

Exit criteria: works end to end against a real local model on the user's setup for at least Illustrious/Anima and one natural-language family; prompts and descriptions never reach the log; the endpoint address is treated like a Forge address (warning for unknown hosts).

## 0.5.0 — Archive 2 and faster start

- Archive, phase 2 (`docs/archive-design.md`): archive by age or tag with a count and size preview, free-space check in the dialog, restore a selection, "Archive first" in the delete-all dialog.
- Archive, phase 3: browse an archive without restoring (thumbnails and search), optional zip export, reminders.
- Instant start: keep the last catalog on disk and show it at once while Forge answers; list checkpoints progressively when Forge is slow (today `/sd-models` is awaited in full).
- Assistant phase 3 (WD-tagger mode, prompt history, optional auto-tags for the gallery) if the user wants it.

## 1.0.0 — Something other people can install

- Windows installer (electron-builder), app icon, a release on GitHub with the installer attached.
- `main` brought up to date with `feature/core`; README install section for the installer; the Forge stats extension install steps checked on a real Forge PC.
- Final whole-branch review, the real-Forge walk-through of every feature, known limitations written down.
- Decide about updates (manual download or auto-update) and about signing.

## Backlog (no version yet)

- Server id bound at call time in `noteSeen` and the preview service across a server switch (narrow race, see STATUS).
- Img2img from a file dropped from outside the app; "Save as" for an image.
- Why Forge sometimes never answers a long hires request (needs Forge's console log at the moment it happens; the app now gives up after 45 s idle).
- More Civitai browser filters (more base models on request, model update notices for the library).
- Archive: encryption of hidden images so they can be archived too.
- A second UI language (all strings are already in one catalog, `src/renderer/locales/en.ts`).

## How a version is made

Features are built one per commit with tests, docs and a `ckpt-YYYYMMDD-N` tag after the push checks (see `CLAUDE.md`).
A version is cut only after the release pass above: the user has seen it, the review is done, the changelog is closed,
and the tag `vX.Y.Z` is set on the pushed commit.
