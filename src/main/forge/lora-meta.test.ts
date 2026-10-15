import { baseFamilyFromMetadata, triggersFromMetadata } from './lora-meta'

test('tag frequency from an object or its JSON text is summed over folders, sorted and capped at eight', () => {
  const folders = {
    '10_style': { 'red hair': 5, smile: 2, '  ': 9, solo: 7 },
    '5_extra': { 'red hair': 4, a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 },
  }
  const expected = ['red hair', 'solo', 'smile', 'a', 'b', 'c', 'd', 'e']
  expect(triggersFromMetadata({ ss_tag_frequency: folders })).toEqual(expected)
  expect(triggersFromMetadata({ ss_tag_frequency: JSON.stringify(folders) })).toEqual(expected)
})

test('missing or damaged tag metadata gives no triggers', () => {
  expect(triggersFromMetadata({})).toEqual([])
  expect(triggersFromMetadata({ ss_tag_frequency: 'not json' })).toEqual([])
  expect(triggersFromMetadata({ ss_tag_frequency: { dir: 'oops' } })).toEqual([])
  expect(triggersFromMetadata({ ss_tag_frequency: { dir: { tag: 'many', other: -1 } } })).toEqual([])
})

test('the base family comes from the training metadata, null when unknown', () => {
  expect(baseFamilyFromMetadata({ ss_base_model_version: 'sdxl_base_v1-0' })).toBe('sdxl')
  expect(baseFamilyFromMetadata({ 'modelspec.architecture': 'Z-Image/lora' })).toBe('zimage')
  expect(baseFamilyFromMetadata({ ss_base_model_version: 'anima' })).toBe('anima')
  expect(baseFamilyFromMetadata({ ss_base_model_version: 'flux-dev' })).toBeNull()
  expect(baseFamilyFromMetadata({})).toBeNull()
})
