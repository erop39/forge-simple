import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Catalog } from '@shared/types'
import { en } from '../locales/en'
import { ModelGalleryDialog } from './ModelGallery'
import { LoraStack } from './LoraStack'
import { catalog, renderWithStore } from './test-store'

const models: Catalog = {
  ...catalog,
  checkpoints: [
    { title: 'sdxl\\alpha.safetensors [aaaa]', name: 'alpha', filename: 'C:\\m\\sdxl\\alpha.safetensors', family: 'sdxl',
      sha256: 'f'.repeat(64), previewUrl: 'fnc-model://local/checkpoint/aaaaaaaaaaaaaaaaaaaa' },
    { title: 'anima\\beta.safetensors [bbbb]', name: 'beta', filename: 'C:\\m\\anima\\beta.safetensors', family: 'anima',
      favorite: true },
    { title: 'anima\\gamma.safetensors [cccc]', name: 'gamma', filename: 'C:\\m\\anima\\gamma.safetensors', family: 'anima' },
  ],
  loras: [
    { name: 'detail', alias: 'detail', path: 'C:\\m\\lora\\detail.safetensors', baseFamily: 'sdxl', triggers: ['sharp', 'skin'], favorite: false },
    { name: 'style_a', alias: 'style_a', path: 'C:\\m\\lora\\style_a.safetensors', baseFamily: 'anima', triggers: [] },
  ],
  loadedCheckpoint: 'sdxl\\alpha.safetensors [aaaa]',
}

const withGallery = (kind: 'checkpoint' | 'lora', extra: object = {}) =>
  renderWithStore(<ModelGalleryDialog />, 'sdxl', { catalog: models, modelGallery: kind, ...extra })

const cards = (): string[] => screen.getAllByRole('button', { pressed: false }).map((b) => b.getAttribute('aria-label') ?? '')
  .filter((label) => label.startsWith('Select '))

test('checkpoints list favorites first, with counts per family, search and a family filter', async () => {
  withGallery('checkpoint')
  expect(screen.getByText('3 of 3')).toBeDefined()
  const grid = screen.getByRole('list', { name: en['models.checkpointsTitle'] })
  expect(within(grid).getAllByRole('listitem').map((li) => li.textContent)[0]).toContain('beta')
  await userEvent.type(screen.getByRole('searchbox'), 'ALPHA')
  expect(screen.getByText('1 of 3')).toBeDefined()
  await userEvent.clear(screen.getByRole('searchbox'))
  await userEvent.type(screen.getByRole('searchbox'), 'anima')
  expect(screen.getByText('2 of 3')).toBeDefined()
  expect(cards()).toHaveLength(2)
})

test('Use selects the checkpoint and closes the gallery; the loaded one is marked', async () => {
  const selectCheckpoint = vi.fn(async () => undefined)
  const { store } = withGallery('checkpoint', { selectCheckpoint })
  expect(screen.getByText(en['models.loaded'])).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: 'Select gamma' }))
  await userEvent.click(screen.getByRole('button', { name: en['models.use'] }))
  expect(selectCheckpoint).toHaveBeenCalledWith('anima\\gamma.safetensors [cccc]')
  expect(store.getState().modelGallery).toBeNull()
})

test('the details panel marks a favorite, sets the family and saves a note on blur', async () => {
  const setModelFavorite = vi.fn(async () => undefined)
  const setCheckpointFamily = vi.fn(async () => undefined)
  const setModelNote = vi.fn(async () => undefined)
  withGallery('checkpoint', { setModelFavorite, setCheckpointFamily, setModelNote })
  await userEvent.click(screen.getByRole('button', { name: 'Select gamma' }))
  await userEvent.click(screen.getByRole('button', { name: en['models.favorite'] }))
  expect(setModelFavorite).toHaveBeenCalledWith('checkpoint', 'C:\\m\\anima\\gamma.safetensors', true)
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['models.setFamily']) }))
  await userEvent.click(await screen.findByRole('menuitemradio', { name: 'SDXL' }))
  expect(setCheckpointFamily).toHaveBeenCalledWith('C:\\m\\anima\\gamma.safetensors', 'sdxl')
  await userEvent.type(screen.getByPlaceholderText(en['models.notePlaceholder']), 'good one')
  await userEvent.tab()
  expect(setModelNote).toHaveBeenCalledWith('checkpoint', 'C:\\m\\anima\\gamma.safetensors', 'good one')
})

test('LoRA: Add puts it into the stack once; other-family LoRA is flagged; trigger words are editable', async () => {
  const setLoraTriggers = vi.fn(async () => undefined)
  const { store } = withGallery('lora', { setLoraTriggers })
  expect(screen.getByText('Made for Anima')).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: 'Select detail' }))
  await userEvent.click(screen.getByRole('button', { name: en['models.add'] }))
  expect(store.getState().params?.loras).toEqual([{ name: 'detail', weight: 1, enabled: true }])
  expect(screen.getByRole('button', { name: en['models.added'] })).toHaveProperty('disabled', true)
  await userEvent.click(screen.getByRole('button', { name: 'Remove sharp' }))
  expect(setLoraTriggers).toHaveBeenCalledWith('C:\\m\\lora\\detail.safetensors', ['skin'])
  await userEvent.type(screen.getByPlaceholderText(en['models.triggerAdd']), 'new word{Enter}')
  expect(setLoraTriggers).toHaveBeenCalledWith('C:\\m\\lora\\detail.safetensors', ['sharp', 'skin', 'new word'])
})

test('the stack: switch off, change weight is a number, insert a trigger once, remove, missing and other-family warnings', async () => {
  const { store } = renderWithStore(<LoraStack />, 'sdxl', {
    catalog: models,
  })
  act(() => store.getState().setParams({
    prompt: 'a cat',
    loras: [
      { name: 'detail', weight: 0.8, enabled: true },
      { name: 'style_a', weight: 1, enabled: true },
      { name: 'ghost', weight: 1, enabled: true },
    ],
  }))
  expect(screen.getByText(en['lora.missing'])).toBeDefined()
  expect(screen.getByText('Made for Anima')).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: 'Add "sharp" to the prompt' }))
  expect(store.getState().params?.prompt).toBe('a cat, sharp')
  await userEvent.click(screen.getByRole('button', { name: 'Add "sharp" to the prompt' }))
  expect(store.getState().params?.prompt).toBe('a cat, sharp')
  await userEvent.click(screen.getByRole('checkbox', { name: 'Use detail' }))
  expect(store.getState().params?.loras[0]).toMatchObject({ name: 'detail', enabled: false })
  await userEvent.click(screen.getByRole('button', { name: 'Remove ghost' }))
  expect(store.getState().params?.loras.map((l) => l.name)).toEqual(['detail', 'style_a'])
})
