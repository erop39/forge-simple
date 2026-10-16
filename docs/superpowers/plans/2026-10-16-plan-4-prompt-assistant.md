# Forge Neo Client — plan 4: local prompt assistant (outline)

**Status:** outline only. It is detailed into full task briefs after the user answers the questions at the end of `docs/prompt-assistant-design.md`; the answers may change the order or drop tasks. Target version: 0.4.0 (see `docs/ROADMAP.md`).

**Authority:** `docs/prompt-assistant-design.md` for behaviour, `CLAUDE.md` for code rules (all HTTP from main, errors as codes, every UI string through `t()`, prompts never in the operation log, styling tokens). Execute on `feature/core`, one task at a time, tests first; each task ends with build, typecheck, full tests, README, CHANGELOG, `CLAUDE.md` and STATUS updates and the push checklist.

**Scope:** a local OpenAI-compatible LLM endpoint, prompt profiles per family, idea → prompt, image → prompt, variants to choose from. Not in scope: bundling a model, any cloud service, training or fine-tuning.

## Tasks

### 1. Endpoint client and settings

`llm/client.ts` in main: chat completions against a user-set base URL (text and `image_url` data-URL messages, timeout, abort, streaming optional), list models, error mapping to `IpcErrorKey` (`error.assistantUnreachable`, `error.assistantModel`, …). Settings: base URL, model name, temperature, max tokens; a Test button (lists models, sends a tiny request). Address validation like a Forge address; a warning for hosts that are neither loopback nor private LAN. Tests against a fake server (success, refusal text, timeout, bad JSON, unreachable).

### 2. Prompt profiles

Table `prompt_profiles` (migration, JSON validated on the way in and out): `id, label, family?, style, systemPrompt, outputFormat, maxChars, rules, examples, negativeHint`. Built-in profiles for the families in `docs/prompt-assistant-design.md` (each checked against its model card before it ships), duplicate/edit/delete for user profiles, export/import through the settings backup as a new section. Tests: validation, round trip, built-ins cannot be deleted but can be duplicated.

### 3. Output cleaning and refusal handling

Pure functions: strip preambles and markdown, split and dedupe tags, enforce `maxChars`, detect refusals, one automatic stricter retry. JSON-schema output where the runtime supports it. Tests with recorded messy answers.

### 4. Idea → prompt

Panel next to the prompt bar: request field, profile (default from the current family), Generate; LoRA trigger words of the enabled LoRA added by code, not by the model; the family's default negative proposed. Three variants (different temperatures), pick one, Replace / Append / Copy; nothing written without the choice. Log entry with profile, model and duration only. Tests: store flow, variant choice, trigger words, error display.

### 5. Image → prompt

"Describe" in the image viewer and drop of an image on the prompt bar (reusing the img2img entry points); the image is read through the managed-image checks and the session lock (a hidden image cannot be described while locked). Two-stage mode (faithful description, then rewrite into the profile) and one-stage mode. Tests: lock refusal, two-stage call order, variants.

### 6. History and polish

Local history of assistant requests (profile, model, time; the text stays on this machine and out of the log), keyboard access, empty/error states, README screens section. Optional if the user asks: WD-tagger mode, gallery auto-tagging from captions (assistant phase 3).

### 7. Integration and release readiness

End-to-end test against a fake endpoint; a manual check against a real local model chosen by the user; CHANGELOG, README, STATUS; whole-branch review before the tag.

## Key dependencies and risks

- A real local model is needed for the manual check; the user must say where it runs (design question 1) before Task 1's defaults are fixed.
- Profile rules for Krea 2 and Anima must be verified on their model cards; wrong built-ins are worse than none.
- Vision models differ in how they take images through each runtime; Task 1 must be tested with at least Ollama and one other runtime.
- Prompts and image descriptions are private data: no log, no repository fixture, no telemetry.
