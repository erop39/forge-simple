# Local prompt assistant: design proposal

Status: proposal, nothing is implemented. It needs the user's answers to the questions at the end.

## Goal

Write generation prompts with a **local** language model, in two ways, for the family the image will be made with:

- **Image → prompt**: describe a picture (a gallery image, or one dropped in) as a prompt in the syntax the chosen model understands.
- **Idea → prompt**: turn a short request (in any language, Russian included) into a full prompt in that syntax.

Everything stays on the user's machines: no cloud service, images and prompts go only to the endpoint the user configures.

## Why the target matters

The families in the app read prompts differently, so the assistant works from a **prompt profile** per target, not one generic prompt.
The exact rules of each model should be checked against its own card before the built-in profile is trusted; profiles are editable so they can be corrected without a release.

| Target (app family) | Style to write | Notes to put in its profile |
|---|---|---|
| SDXL, Illustrious, Pony, NoobAI | comma-separated booru-style tags | Pony wants its score tags first; Illustrious/NoobAI like tags in a fixed order (count, character, series, clothing, pose, scene, quality) |
| Anima | tags and/or natural language | verify which works best on the user's checkpoints, then fix it in the profile |
| Z-Image (Turbo/Base) | natural-language sentences | text encoder is an LLM: full descriptive prose works, short and concrete beats long and vague |
| Qwen (image) | long natural language | handles text-in-image: quote the text to render |
| Lumina | natural language | descriptive paragraphs |
| Krea 2 | natural language (verify) | to be checked on the model card |

A profile is data: `{ id, label, family?, style: tags | natural | mixed, systemPrompt, outputFormat, maxChars, rules, examples[], negativeHint }`. Built-in ones ship with the app; the user can duplicate and edit them; they travel with the settings backup.

## Where the models come from

The app should not bundle a model. It talks to any **OpenAI-compatible chat endpoint** (images sent as `image_url` data URLs), which every common local runtime offers:

| Runtime | Why | Default address |
|---|---|---|
| Ollama | simplest install, pulls models by name, vision supported | `http://127.0.0.1:11434` (OpenAI API under `/v1`) |
| LM Studio | GUI, easy model browsing | `http://127.0.0.1:1234/v1` |
| llama.cpp `llama-server` | lightest, any GGUF with its `mmproj` | `http://127.0.0.1:8080/v1` |

Models worth offering (Hugging Face / the Ollama library; sizes are rough Q4 figures from [the roundups below](#sources), check each model card):

| Model | Use | Rough VRAM |
|---|---|---|
| Qwen3-VL 4B / 8B (`qwen3-vl` on Ollama) | best all-round vision model for its size; also writes prompts from text | about 3.5 GB / 6 GB |
| Gemma 3 4B / 12B | good vision, easy to run, strong multilingual text | about 3 GB / 8 GB |
| MiniCPM-V 4.5 (8B) | solid on 6–8 GB cards | about 6 GB |
| JoyCaption (Llama 3.1 8B + SigLIP) | built to caption images for diffusion training: styles for Stable Diffusion prompts, booru tags, descriptive captions; uncensored | about 17 GB in bf16, less quantised; the official route is Hugging Face `transformers`, no GGUF or Ollama build was confirmed |
| WD tagger (small ONNX model) | exact booru tags, no hallucinated prose, tiny | well under 1 GB |
| Moondream 2 | only option under about 2 GB | about 2 GB |
| Qwen3 / Gemma 3 text models | the "idea → prompt" step when no picture is involved | 5–9 GB |

Notes that matter for the user's setup:

- Forge's GPU has about 17 GB in total, so an 8B vision model at Q4 (about 6 GB) can sit next to a family model that is not loaded at full size; for a big model the assistant should offer to unload Forge's checkpoint first (the app can already do that) or use a second small model.
- The LLM can run on the home PC next to Forge (VRAM shared) or on the laptop (CPU/iGPU, slow but private). The endpoint is a setting, so both work.
- Refusals: general models may refuse some pictures. The profile can say what to do, and the app detects a refusal answer and suggests a different model (JoyCaption or an uncensored fine-tune) instead of inserting it.

## Flow

1. Settings → Prompt assistant: endpoint, model name, "Test" button (lists models, sends a tiny request), temperature, max tokens.
2. **Idea → prompt**: a field in the prompt bar (or a panel) takes the request; the selected target profile is the default for the current family; the LoRA that are on contribute their trigger words automatically; the family's default negative is proposed.
3. **Image → prompt**: "Describe" in the image viewer (and drag & drop onto the prompt bar, like img2img). Two stages work better with small models: stage 1 writes a faithful plain description (or WD tags), stage 2 rewrites it into the profile's syntax. One-stage mode is allowed for strong models.
4. The result is **three variants** (different temperatures or seeds) shown side by side; the user picks one, edits it, and chooses Replace, Append, or Copy. Nothing is written to the prompt field without that choice.
5. Prompt history of the assistant (what was asked, which profile), kept locally.

## Technical shape

- All HTTP from the main process (as for Forge and Civitai); the renderer only sees results. A new `llm/` module (client, profiles, output cleaning) and IPC `assistant:*`.
- Output cleaning per profile: strip preambles and markdown, dedupe tags, enforce the length limit, reject refusals, one automatic retry with a stricter instruction. JSON-schema output where the runtime supports it (Ollama `format`).
- Prompts and descriptions never reach the operation log (existing rule); the log gets the profile name, model name and duration only.
- The endpoint is user-chosen; a non-loopback, non-LAN address gets the same kind of warning as an unknown Forge address.
- Cost: one request at a time, a few seconds on a 4–8B model on a GPU; no background polling.

## Phases

1. Endpoint settings and test, profile list and editor, **Idea → prompt** (text only). Smallest useful part, no vision model needed.
2. **Image → prompt** from the viewer and by drag & drop, two-stage mode, variants side by side.
3. WD-tagger mode for tag families, trigger-word injection, prompt history, and (optional) captioning the gallery to give images tags automatically.

## Decisions needed from the user

1. Where will the LLM run: on the home PC with Forge, or on the laptop? (Decides whether VRAM sharing needs special care.)
2. Runtime preference: Ollama (proposed, simplest), LM Studio, or llama.cpp?
3. Which targets matter first? (Proposed order: Illustrious/Anima, Z-Image, Krea 2, then the rest.)
4. Is Russian input with English output needed (proposed: yes)?
5. Must it work with uncensored models only, or are general models fine for the first version?
6. Should phase 3 include auto-tagging the whole gallery from captions?

## Sources

- [JoyCaption on GitHub](https://github.com/fpgaminer/joycaption), [ComfyUI JoyCaption node (VRAM notes)](https://github.com/o-l-l-i/ComfyUI-Olm-JoyCaption)
- [Best local vision language models 2026 (tinyweights)](https://tinyweights.dev/posts/best-local-vision-language-models-2026/), [Best vision models you can run locally (InsiderLLM)](https://insiderllm.com/guides/vision-models-locally/), [Best LLMs to run locally in 2026 (llmhardware)](https://llmhardware.io/guides/best-llms-to-run-locally)

The roundups are SEO-style pages that disagree on rankings; confirm sizes and licences on each model's own card before choosing.
