import { PROFILES } from '@shared/profiles'
import type { GenerationParams } from '@shared/types'
import type { Txt2ImgBody } from '../forge/client'
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
  if (profile.shift && p.shift !== null && findings.shiftOptionKey !== null) {
    override_settings[findings.shiftOptionKey] = p.shift
  }

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
  return body
}
