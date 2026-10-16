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
  const setModelTriggers = vi.fn(async () => undefined)
  const { store } = withGallery('lora', { setModelTriggers })
  expect(screen.getByText('Made for Anima')).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: 'Select detail' }))
  await userEvent.click(screen.getByRole('button', { name: en['models.add'] }))
  expect(store.getState().params?.loras).toEqual([{ name: 'detail', weight: 1, enabled: true }])
  expect(screen.getByRole('button', { name: en['models.added'] })).toHaveProperty('disabled', true)
  await userEvent.click(screen.getByRole('button', { name: 'Remove sharp' }))
  expect(setModelTriggers).toHaveBeenCalledWith('lora', 'C:\\m\\lora\\detail.safetensors', ['skin'])
  await userEvent.type(screen.getByPlaceholderText(en['models.triggerAdd']), 'new word{Enter}')
  expect(setModelTriggers).toHaveBeenCalledWith('lora', 'C:\\m\\lora\\detail.safetensors', ['sharp', 'skin', 'new word'])
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

test('Update from Civitai asks first, says what is sent, and only then enables and starts the lookup', async () => {
  const setCivitaiEnabled = vi.fn(async () => undefined)
  const updateFromCivitai = vi.fn(async () => undefined)
  withGallery('lora', { setCivitaiEnabled, updateFromCivitai })
  await userEvent.click(screen.getByRole('button', { name: en['civitai.update'] }))
  expect(screen.getByText(en['civitai.consentBody'])).toBeDefined()
  expect(updateFromCivitai).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: en['civitai.consentNo'] }))
  expect(setCivitaiEnabled).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: en['civitai.update'] }))
  await userEvent.click(screen.getByRole('button', { name: en['civitai.consentAllow'] }))
  expect(setCivitaiEnabled).toHaveBeenCalledWith(true)
  expect(updateFromCivitai).toHaveBeenCalledOnce()
})

test('with consent given the button starts at once; progress and Stop show while it runs; found models link to Civitai', async () => {
  const updateFromCivitai = vi.fn(async () => undefined)
  const cancelCivitai = vi.fn(async () => undefined)
  const openOnCivitai = vi.fn(async () => undefined)
  const withLink: Catalog = { ...models, loras: [{ ...models.loras[0]!,
    civitai: { url: 'https://civitai.com/models/7?modelVersionId=70', name: 'Detail Tweaker', baseModel: 'Illustrious', versionId: 70 } },
  models.loras[1]!] }
  const { store } = renderWithStore(<ModelGalleryDialog />, 'sdxl', {
    catalog: withLink, modelGallery: 'lora', updateFromCivitai, cancelCivitai, openOnCivitai,
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: true },
  })
  await userEvent.click(screen.getByRole('button', { name: en['civitai.update'] }))
  expect(updateFromCivitai).toHaveBeenCalledOnce()
  act(() => store.setState({ civitai: { running: true, done: 3, total: 40, found: 2, paused: false } }))
  expect(screen.getByRole('status').textContent).toBe('Civitai: 3 of 40')
  await userEvent.click(screen.getByRole('button', { name: en['civitai.cancel'] }))
  expect(cancelCivitai).toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Select detail' }))
  await userEvent.click(screen.getByRole('button', { name: en['civitai.open'] }))
  expect(openOnCivitai).toHaveBeenCalledWith('lora', String.raw`C:\m\lora\detail.safetensors`)
})

test('sorting by release date, use and recent addition puts known values first and shows them on the cards', async () => {
  const dated: Catalog = { ...models, checkpoints: [
    { ...models.checkpoints[0]!, addedAt: null, releasedAt: Date.parse('2026-01-01'), uses: 2, lastUsedAt: 5 },
    { ...models.checkpoints[1]!, addedAt: Date.parse('2026-10-01'), releasedAt: Date.parse('2026-06-01'), uses: 9, lastUsedAt: 9 },
    { ...models.checkpoints[2]!, addedAt: Date.parse('2026-10-10'), releasedAt: null, uses: 0, lastUsedAt: null },
  ] }
  renderWithStore(<ModelGalleryDialog />, 'sdxl', { catalog: dated, modelGallery: 'checkpoint' })
  const order = (): string[] => within(screen.getByRole('list', { name: en['models.checkpointsTitle'] })).getAllByRole('listitem')
    .map((li) => li.textContent!.match(/alpha|beta|gamma/)![0])
  const pick = async (label: string): Promise<void> => {
    await userEvent.click(screen.getByRole('button', { name: new RegExp(en['models.sort']) }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: label }))
  }
  await pick(en['models.sort.released'])
  expect(order()).toEqual(['beta', 'alpha', 'gamma'])
  await pick(en['models.sort.used'])
  expect(order()).toEqual(['beta', 'alpha', 'gamma'])
  expect(screen.getByText('Used 9×')).toBeDefined()
  await pick(en['models.sort.added'])
  expect(order()).toEqual(['gamma', 'beta', 'alpha'])
})

test('a checkpoint shows Civitai trigger words that insert into the prompt, and a single file can be updated from its card', async () => {
  const insertPromptWord = vi.fn()
  const updateModelFromCivitai = vi.fn(async () => 'found' as const)
  const withWords: Catalog = { ...models, checkpoints: [{ ...models.checkpoints[0]!, triggers: ['masterpiece style'] }, ...models.checkpoints.slice(1)] }
  renderWithStore(<ModelGalleryDialog />, 'sdxl', {
    catalog: withWords, modelGallery: 'checkpoint', insertPromptWord, updateModelFromCivitai,
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: true },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Select alpha' }))
  await userEvent.click(screen.getByRole('button', { name: 'Add "masterpiece style" to the prompt' }))
  expect(insertPromptWord).toHaveBeenCalledWith('masterpiece style')
  const buttons = screen.getAllByRole('button', { name: en['civitai.updateOne'] })
  await userEvent.click(buttons[buttons.length - 1]!)
  expect(updateModelFromCivitai).toHaveBeenCalledWith('checkpoint', String.raw`C:\m\sdxl\alpha.safetensors`)
  expect(await screen.findByText(en['civitai.one.found'])).toBeDefined()
})

test('adding a LoRA puts its trigger words into the prompt: the user\'s and Civitai\'s whole, from file tags only the first', async () => {
  const withSources: Catalog = { ...models, loras: [
    { ...models.loras[0]!, triggers: ['civi one', 'civi two'], triggersFrom: 'civitai' },
    { name: 'tagged', alias: 'tagged', path: 'C:\m\lora\tagged.safetensors', baseFamily: 'sdxl', triggers: ['most common', '1girl', 'solo'], triggersFrom: 'file' },
  ] }
  const { store } = renderWithStore(<ModelGalleryDialog />, 'sdxl', { catalog: withSources, modelGallery: 'lora' })
  act(() => store.getState().setParams({ prompt: 'a cat, civi one' }))
  await userEvent.click(screen.getByRole('button', { name: 'Select detail' }))
  await userEvent.click(screen.getByRole('button', { name: en['models.add'] }))
  expect(store.getState().params?.prompt).toBe('a cat, civi one, civi two')
  await userEvent.click(screen.getByRole('button', { name: 'Select tagged' }))
  await userEvent.click(screen.getByRole('button', { name: en['models.add'] }))
  expect(store.getState().params?.prompt).toBe('a cat, civi one, civi two, most common')
})
