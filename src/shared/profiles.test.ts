import { PROFILES, RATIOS, defaultParams, detectFamily, dimsForRatio } from './profiles'
import type { Family } from './types'

const none = { samplers: [], schedulers: [] }

test.each<[string, Family]>([
  ['Illustrious-XL-v2.safetensors', 'sdxl'], ['ponyDiffusionV6XL.safetensors', 'sdxl'],
  ['z_image_turbo_bf16.safetensors', 'zimage'], ['Z-Image-Base.gguf', 'zimage'],
  ['qwen_image_fp8.safetensors', 'qwen'], ['lumina_2.safetensors', 'lumina'],
  ['krea2_turbo_fp8.safetensors', 'krea2'], ['anima-2b-preview.safetensors', 'anima'],
  ['mystery.safetensors', 'sdxl'],
])('detectFamily(%s) -> %s', (name, family) => {
  expect(detectFamily(name)).toBe(family)
})

test('detectFamily matches on the base name with either path separator', () => {
  expect(detectFamily('C:\\models\\qwen\\mystery.safetensors')).toBe('sdxl')
  expect(detectFamily('models/krea/Qwen_Image.safetensors')).toBe('qwen')
  expect(detectFamily('C:\\models\\Lumina_2.safetensors')).toBe('lumina')
})

test('dimsForRatio keeps the area and snaps to 64', () => {
  expect(dimsForRatio([3, 4], 1024 * 1024)).toEqual({ width: 896, height: 1152 })
  expect(dimsForRatio([1, 1], 1024 * 1024)).toEqual({ width: 1024, height: 1024 })
})

test('dimsForRatio never returns less than 64', () => {
  expect(dimsForRatio([16, 9], 1)).toEqual({ width: 64, height: 64 })
})

test('RATIOS lists the supported ratios in order', () => {
  expect(RATIOS).toEqual([[1, 1], [3, 4], [4, 3], [2, 3], [3, 2], [9, 16], [16, 9]])
})

test('defaultParams falls back to the first available sampler and scheduler', () => {
  const p = defaultParams('krea2', 'krea2.safetensors', { samplers: ['DPM++ 2M'], schedulers: ['Karras'] })
  expect([p.sampler, p.scheduler]).toEqual(['DPM++ 2M', 'Karras'])
})

test('defaultParams keeps the profile sampler when the server has it', () => {
  const p = defaultParams('sdxl', 'x.safetensors', { samplers: ['DPM++ 2M', 'Euler a'], schedulers: ['Karras', 'Automatic'] })
  expect([p.sampler, p.scheduler]).toEqual(['Euler a', 'Automatic'])
})

test('defaultParams keeps the profile sampler and scheduler when the lists are empty', () => {
  const p = defaultParams('zimage', 'z.safetensors', none)
  expect([p.sampler, p.scheduler]).toEqual(['Euler', 'Simple'])
})

test('defaultParams returns the neutral request fields', () => {
  expect(defaultParams('qwen', 'q.safetensors', none)).toMatchObject({
    family: 'qwen', checkpoint: 'q.safetensors', seed: -1, count: 1,
    prompt: '', negativePrompt: '', modules: [], loras: [],
    width: 1024, height: 1024, steps: 20, cfgScale: 4, shift: 3, clipSkip: null,
  })
})

test('krea2 has no negative prompt, no cfg, no clip skip', () => {
  expect(PROFILES.krea2).toMatchObject({ negative: false, cfg: false, distilledCfg: true, clipSkip: false })
  expect(PROFILES.krea2.defaults.clipSkip).toBeNull()
})

test('sdxl has clip skip 2 and no shift', () => {
  expect(PROFILES.sdxl).toMatchObject({ clipSkip: true, shift: false, requiresModules: false })
  expect(PROFILES.sdxl.defaults.clipSkip).toBe(2)
  expect(PROFILES.sdxl.defaults.shift).toBeNull()
})
