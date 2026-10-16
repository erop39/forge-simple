# Forge API notes

Findings from running `tools/probe/probe.mjs` against a real Forge Neo instance (480 checkpoints,
25 modules). The values in `src/main/forge/findings.ts` follow them. The probe report itself
(`tools/probe/probe-report.json`) holds local file paths and is never committed.

## modulesAs: `path`

`options.forge_additional_modules` holds full file paths (for example
`D:\forge\models\VAE\example_vae.safetensors`), not module names. The client sends the
`filename` of each module from `/sdapi/v1/sd-modules`.

## shiftField: `distilled_cfg_scale`

No option holds a shift value. Options only carry per-preset flags: `xl_show_shift`,
`krea_show_shift` and `pid_show_shift` are false; `zit_show_shift`, `lumina_show_shift`,
`anima_show_shift`, `wan_show_shift` and `ernie_show_shift` are true. Forge Neo relabels its
distilled-CFG slider as "Shift" for those presets, so shift travels in the request field
`distilled_cfg_scale` (never in `override_settings`). No family uses both shift and distilled CFG.

## thumbRoute: `true`

`/sd_extra_networks/thumb?filename=` answered 200 for some candidates, so checkpoint previews can
be requested from it.

## Per-preset default modules

Options carry a default module list per preset, each an array of full paths (possibly empty, and
possibly pointing at files that no longer exist): `forge_additional_modules_xl`, `_zit`, `_qwen`,
`_lumina`, `_krea`, `_anima` (the server has others we do not use). The catalog exposes them as
`familyModules`, and `catalog:defaults` seeds a new parameter set with the list of its family.

## Checkpoint titles

Titles are relative paths with folders, optionally followed by ` [hash]`, for example
`krea2\exampleKreaMix_v1.safetensors`, `IL\exampleIllustrious_v3.safetensors`,
`anima 2026\exampleAnimaMix_fp8.safetensors [0123abcd45]`. Some models (Krea) are
identifiable only by the folder, so the family is detected from the title: base name first, then
folders from the innermost out.

## Hires needs hr_additional_modules

A txt2img with `enable_hr` and no `hr_additional_modules` answers 500 `{"error":"TypeError"}`, whatever the upscaler or
resize fields are (found 2026-10-16). `["Use same choices"]` works for every family tried (sdxl, anima, krea2); `[]` also
works but would load no VAE or text encoder for the second pass. `hr_checkpoint_name`, `hr_sampler_name` and
`hr_scheduler` can stay unset; `"Use same checkpoint"` for the checkpoint caused an AssertionError. Latent second-pass
modes are listed by `GET /sdapi/v1/latent-upscale-modes`, not by `/upscalers`.

## LoRA list is slow

`GET /sdapi/v1/loras` timed out at the 10 s list timeout. It has its own 60 s timeout, and a
failure of that call is not fatal: the catalog loads with an empty LoRA list and a warning in the
operation log.

## Schedulers

Scheduler items have lowercase names (`automatic`, `simple`, `karras`, ...); the client maps them
to their labels.
