import type { Catalog } from '@shared/types'
import { inLibrary } from './wishlist'

const catalog = (over: Partial<Catalog> = {}): Catalog => ({
  checkpoints: [], modules: [], loras: [], samplers: [], schedulers: [], upscalers: [], loadedCheckpoint: null, fetchedAt: 1, familyModules: {}, ...over,
})
const wished = { modelId: 7, versionId: 70, files: ['Detail_Tweaker_v3.safetensors'] }

test('a file with the same name counts, whatever its folder or case, before any Civitai lookup', () => {
  const lib = catalog({ loras: [{ name: 'd', alias: 'd', path: 'C:\\models\\Lora\\detail_tweaker_v3.SAFETENSORS' }] })
  expect(inLibrary(wished, lib)).toBe(true)
  expect(inLibrary(wished, catalog({ loras: [{ name: 'd', alias: 'd', path: '/m/other.safetensors' }] }))).toBe(false)
})

test('a Civitai link to that very version counts; another version of the same model does not', () => {
  const link = (versionId: number) => ({ url: 'https://civitai.com/models/7?modelVersionId=' + versionId, name: 'x', baseModel: 'SDXL 1.0', versionId })
  expect(inLibrary(wished, catalog({ checkpoints: [{ title: 't', name: 'n', filename: '/m/a.safetensors', family: 'sdxl', civitai: link(70) }] }))).toBe(true)
  expect(inLibrary(wished, catalog({ checkpoints: [{ title: 't', name: 'n', filename: '/m/a.safetensors', family: 'sdxl', civitai: link(69) }] }))).toBe(false)
  expect(inLibrary(wished, catalog())).toBe(false)
})
