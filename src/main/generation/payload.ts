import { PROFILES } from '@shared/profiles'
import type { GenerationParams } from '@shared/types'
import type { Img2ImgBody, Txt2ImgBody, UpscaleBody } from '../forge/client'
import type { ProbeFindings } from '../forge/findings'

/** Pure: turns the form state into a Forge txt2img request body without touching its input. */
export function buildTxt2ImgBody(p: GenerationParams, findings: ProbeFindings): Txt2ImgBody {
  const profile = PROFILES[p.family]

  const loraTags = p.loras
    .filter((l) => l.enabled)
    .map((l) => ` <lora:${l.name}:${l.weight}>`)
    .join('')

  const override_settings: Record<string, unknown> = {
    sd_model_checkpoint: p.checkpoint,
    forge_additional_modules: [...p.modules],
  }
  if (profile.clipSkip && p.clipSkip !== null) override_settings.CLIP_stop_at_last_layers = p.clipSkip

  const body: Txt2ImgBody = {
    prompt: p.prompt + loraTags,
    negative_prompt: profile.negative ? p.negativePrompt : '',
    steps: p.steps,
    cfg_scale: profile.cfg ? p.cfgScale : 1,
    sampler_name: p.sampler,
    scheduler: p.scheduler,
    width: p.width,
    height: p.height,
    seed: p.seed,
    batch_size: 1,
    n_iter: 1,
    send_images: true,
    save_images: false,
    override_settings,
    override_settings_restore_afterwards: false,
  }
  if (profile.distilledCfg) body.distilled_cfg_scale = p.distilledCfg
  // Forge Neo relabels the distilled-CFG slider as "Shift" for the shift families; no family has both.
  if (profile.shift && p.shift !== null && findings.shiftField !== null) body[findings.shiftField] = p.shift
  if (p.hires && p.hires.scale > 1) {
    body.enable_hr = true
    body.hr_scale = p.hires.scale
    body.hr_upscaler = p.hires.upscaler
    body.hr_second_pass_steps = p.hires.secondPassSteps
    body.denoising_strength = p.hires.denoisingStrength
  }
  return body
}

/** Source bytes arrive only at execution; the persisted params hold only the image ID. */
export function buildImg2ImgBody(p: GenerationParams, sourceBase64: string, findings: ProbeFindings): Img2ImgBody {
  if (!p.img2img) throw new Error('Missing img2img settings')
  const { enable_hr: _enabled, hr_scale: _scale, hr_upscaler: _upscaler,
    hr_second_pass_steps: _steps, denoising_strength: _denoise, ...base } = buildTxt2ImgBody(p, findings)
  return { ...base, init_images: [sourceBase64], denoising_strength: p.img2img.denoisingStrength,
    resize_mode: p.img2img.resizeMode }
}

/** Extras runs on a saved image without the txt2img model and prompt fields. */
export function buildUpscaleBody(p: GenerationParams, sourceBase64: string): UpscaleBody {
  if (!p.upscale) throw new Error('Missing upscale settings')
  return { image: sourceBase64, upscaling_resize: p.upscale.scale,
    upscaler_1: p.upscale.upscaler, resize_mode: 0, show_extras_results: true }
}
