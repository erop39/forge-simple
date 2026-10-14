import type { CheckpointInfo, Family } from '@shared/types'
import { en } from '../locales/en'
import { checkpointOptions } from './checkpoint-options'

const info = (title: string, name: string, family: Family): CheckpointInfo => ({
  title,
  name,
  filename: `C:\\models\\${name}.safetensors`,
  family,
})

test('groups checkpoints by family in the profile order, then by name ignoring case, numbers natural', () => {
  const options = checkpointOptions([
    info('anima\\anima_v2.safetensors [1]', 'anima_v2', 'anima'),
    info('krea\\krea2_turbo.safetensors [2]', 'krea2_turbo', 'krea2'),
    info('il\\zetaMix_v10.safetensors [3]', 'zetaMix_v10', 'sdxl'),
    info('il\\alphaMix_v9.safetensors [4]', 'alphaMix_v9', 'sdxl'),
    info('il\\AlphaMix_v10.safetensors [5]', 'AlphaMix_v10', 'sdxl'),
    info('anima\\Anima_base.safetensors [6]', 'Anima_base', 'anima'),
    info('zimage\\z_image_turbo.safetensors [7]', 'z_image_turbo', 'zimage'),
  ])
  expect(options.map((o) => o.label)).toEqual([
    'alphaMix_v9',
    'AlphaMix_v10',
    'zetaMix_v10',
    'z_image_turbo',
    'krea2_turbo',
    'Anima_base',
    'anima_v2',
  ])
  expect(options.map((o) => o.group)).toEqual([
    en['family.sdxl'],
    en['family.sdxl'],
    en['family.sdxl'],
    en['family.zimage'],
    en['family.krea2'],
    en['family.anima'],
    en['family.anima'],
  ])
})

test('the value is the checkpoint title', () => {
  const [option] = checkpointOptions([info('il\\a.safetensors [1]', 'a', 'sdxl')])
  expect(option?.value).toBe('il\\a.safetensors [1]')
})

test('does not reorder the input array', () => {
  const input = [info('b [1]', 'b', 'sdxl'), info('a [2]', 'a', 'sdxl')]
  checkpointOptions(input)
  expect(input.map((c) => c.name)).toEqual(['b', 'a'])
})
