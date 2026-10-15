import { defaultParams } from '@shared/profiles'
import type { Family, GenerationParams } from '@shared/types'
import { buildImg2ImgBody, buildTxt2ImgBody } from './payload'

const avail = { samplers: ['Euler a', 'Euler'], schedulers: ['Automatic', 'Simple'] }
const base = defaultParams('sdxl', 'sd_xl_base.safetensors [abc]', avail)
const F = { shiftField: 'distilled_cfg_scale', modulesAs: 'path', thumbRoute: true } as const
const forFamily = (family: Family): GenerationParams => defaultParams(family, `${family}.safetensors`, avail)

test('img2img maps source bytes and resize controls without txt2img hires fields', () => {
  const p: GenerationParams = { ...base, img2img: { sourceImageId: 42, denoisingStrength: 0.55, resizeMode: 2 } }
  const body = buildImg2ImgBody(p, 'cG5n', F)
  expect(body).toMatchObject({ init_images: ['cG5n'], denoising_strength: 0.55, resize_mode: 2,
    prompt: p.prompt, width: p.width, height: p.height })
  expect(body).not.toHaveProperty('enable_hr')
  expect(body).not.toHaveProperty('hr_scale')
})

test('sdxl: checkpoint, clip skip and fixed flags', () => {
  const b = buildTxt2ImgBody({ ...base, prompt: 'a cat', negativePrompt: 'blurry' }, F)
  expect(b).toMatchObject({
    prompt: 'a cat', negative_prompt: 'blurry', cfg_scale: 5, batch_size: 1, n_iter: 1,
    send_images: true, save_images: false, override_settings_restore_afterwards: false,
    sampler_name: 'Euler a', scheduler: 'Automatic', steps: 28, width: 896, height: 1152,
  })
  expect(b.override_settings).toEqual({
    sd_model_checkpoint: 'sd_xl_base.safetensors [abc]',
    forge_additional_modules: [],
    CLIP_stop_at_last_layers: 2,
  })
  expect(b).not.toHaveProperty('distilled_cfg_scale')
})

test('krea2: distilled cfg, cfg 1, empty negative, no clip skip', () => {
  const b = buildTxt2ImgBody({ ...forFamily('krea2'), cfgScale: 7, negativePrompt: 'ignored' }, F)
  expect(b.negative_prompt).toBe('')
  expect(b.cfg_scale).toBe(1)
  expect(b.distilled_cfg_scale).toBe(3.5)
  expect(b.override_settings).not.toHaveProperty('CLIP_stop_at_last_layers')
})

test('clip skip is omitted when the profile has it but the value is null', () => {
  const b = buildTxt2ImgBody({ ...base, clipSkip: null }, F)
  expect(b.override_settings).not.toHaveProperty('CLIP_stop_at_last_layers')
})

test('zimage: shift travels in distilled_cfg_scale, not in override_settings', () => {
  const b = buildTxt2ImgBody(forFamily('zimage'), F)
  expect(b.distilled_cfg_scale).toBe(3)
  expect(Object.keys(b.override_settings).sort()).toEqual(['forge_additional_modules', 'sd_model_checkpoint'])
})

test('shift is omitted when findings.shiftField is null', () => {
  const b = buildTxt2ImgBody(forFamily('zimage'), { ...F, shiftField: null })
  expect(b).not.toHaveProperty('distilled_cfg_scale')
})

test('shift is omitted when the profile has no shift', () => {
  const b = buildTxt2ImgBody({ ...base, shift: 3 }, F)
  expect(b).not.toHaveProperty('distilled_cfg_scale')
})

test('shift is omitted when the value is null', () => {
  const b = buildTxt2ImgBody({ ...forFamily('zimage'), shift: null }, F)
  expect(b).not.toHaveProperty('distilled_cfg_scale')
})

test('modules are passed through in order', () => {
  const b = buildTxt2ImgBody({ ...forFamily('zimage'), modules: ['b.safetensors', 'a.safetensors'] }, F)
  expect(b.override_settings.forge_additional_modules).toEqual(['b.safetensors', 'a.safetensors'])
})

test('enabled loras are appended to the prompt, disabled ones are not', () => {
  const b = buildTxt2ImgBody({
    ...base, prompt: 'a cat', loras: [
      { name: 'film', weight: 0.8, enabled: true },
      { name: 'off', weight: 1, enabled: false },
    ],
  }, F)
  expect(b.prompt).toBe('a cat <lora:film:0.8>')
})

test('loras are appended in list order with default number formatting', () => {
  const b = buildTxt2ImgBody({
    ...base, prompt: 'a cat', loras: [
      { name: 'a', weight: 1, enabled: true },
      { name: 'b', weight: 0.5, enabled: true },
    ],
  }, F)
  expect(b.prompt).toBe('a cat <lora:a:1> <lora:b:0.5>')
})

test('a prompt without enabled loras is unchanged', () => {
  const b = buildTxt2ImgBody({ ...base, prompt: 'a cat', loras: [{ name: 'off', weight: 1, enabled: false }] }, F)
  expect(b.prompt).toBe('a cat')
})

test('seed -1 and explicit seed are passed as is', () => {
  expect(buildTxt2ImgBody({ ...base, seed: -1 }, F).seed).toBe(-1)
  expect(buildTxt2ImgBody({ ...base, seed: 12345 }, F).seed).toBe(12345)
})

test('hires fix adds Forge second-pass fields only when enabled', () => {
  const off = buildTxt2ImgBody({ ...base, hires: { scale: 1, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 } }, F)
  expect(off).not.toHaveProperty('enable_hr')
  const on = buildTxt2ImgBody({ ...base, hires: { scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 } }, F)
  expect(on).toMatchObject({ enable_hr: true, hr_scale: 2, hr_upscaler: 'Latent', hr_second_pass_steps: 12, denoising_strength: 0.4 })
  expect(buildTxt2ImgBody(base, F)).not.toHaveProperty('enable_hr') // older saved jobs have no hires settings
})

test('the input params are not mutated', () => {
  const p: GenerationParams = {
    ...base, prompt: 'a cat', modules: ['m'], loras: [{ name: 'film', weight: 0.8, enabled: true }],
  }
  const snapshot = structuredClone(p)
  const b = buildTxt2ImgBody(p, F)
  expect(p).toEqual(snapshot)
  expect(b.override_settings.forge_additional_modules).not.toBe(p.modules)
})
