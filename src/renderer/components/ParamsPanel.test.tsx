import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '../locales/en'
import { ParamsPanel } from './ParamsPanel'
import { PromptBar } from './PromptBar'
import { renderWithStore } from './test-store'

const open = { panelOpen: true }
const row = (name: string) => screen.queryByRole('spinbutton', { name }) ?? screen.queryByRole('slider', { name })

function expectSlider(name: string, min: string, max: string): HTMLElement {
  const slider = screen.getByRole('slider', { name })
  expect(slider.getAttribute('aria-valuemin')).toBe(min)
  expect(slider.getAttribute('aria-valuemax')).toBe(max)
  return slider
}

test('Shift is a slider from 0 to 20 in steps of 0.5', async () => {
  const { store } = renderWithStore(<ParamsPanel />, 'zimage', open)
  store.getState().setParams({ shift: 3 })
  const slider = expectSlider(en['params.shift'], '0', '20')
  slider.focus()
  await userEvent.keyboard('{ArrowRight}')
  expect(store.getState().params?.shift).toBe(3.5)
})

test('CFG now lives in the prompt bar: sdxl shows Clip skip here, no CFG rows', () => {
  renderWithStore(<ParamsPanel />, 'sdxl', open)
  expect(row(en['params.cfg'])).toBeNull()
  expect(row(en['params.clipSkip'])).not.toBeNull()
  expect(row(en['params.distilledCfg'])).toBeNull()
  expect(row(en['params.shift'])).toBeNull()
})

test('krea2 shows neither Clip skip nor CFG rows here', () => {
  renderWithStore(<ParamsPanel />, 'krea2', open)
  expect(row(en['params.distilledCfg'])).toBeNull()
  expect(row(en['params.cfg'])).toBeNull()
  expect(row(en['params.clipSkip'])).toBeNull()
})

test('Shift row is hidden when its value is null', () => {
  const { store, unmount } = renderWithStore(<ParamsPanel />, 'zimage', open)
  expect(row(en['params.shift'])).not.toBeNull()
  unmount()
  const params = { ...store.getState().params!, shift: null }
  renderWithStore(<ParamsPanel />, 'zimage', { ...open, params })
  expect(row(en['params.shift'])).toBeNull()
})

test('Seed shows "random" for -1 and the number otherwise', async () => {
  const { store } = renderWithStore(<ParamsPanel />, 'sdxl', open)
  const seed = screen.getByRole('textbox', { name: en['params.seed'] }) as HTMLInputElement
  expect(seed.value).toBe(en['params.seedRandom'])
  await userEvent.click(seed)
  await userEvent.keyboard('42')
  expect(store.getState().params?.seed).toBe(42)
  await userEvent.tab()
  expect(seed.value).toBe('42')
  await userEvent.click(screen.getByRole('button', { name: en['params.seedReset'] }))
  expect(store.getState().params?.seed).toBe(-1)
  expect(seed.value).toBe(en['params.seedRandom'])
})

test('clearing the seed field sets -1 and non-numeric text is ignored', async () => {
  const { store } = renderWithStore(<ParamsPanel />, 'sdxl', open)
  store.getState().setParams({ seed: 7 })
  const seed = screen.getByRole('textbox', { name: en['params.seed'] })
  await userEvent.clear(seed)
  expect(store.getState().params?.seed).toBe(-1)
  await userEvent.type(seed, 'ab')
  expect(store.getState().params?.seed).toBe(-1)
})

test('adding and removing a module updates params.modules in order', async () => {
  const { store } = renderWithStore(<ParamsPanel />, 'zimage', open)
  const add = async (name: string) => {
    await userEvent.click(screen.getByRole('button', { name: new RegExp(en['params.addModule']) }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name }))
  }
  await add('clip.safetensors')
  await add('ae.safetensors')
  expect(store.getState().params?.modules).toEqual([
    'C:\\models\\text_encoder\\clip.safetensors',
    'C:\\models\\VAE\\ae.safetensors',
  ])
  expect(screen.getByText('clip.safetensors')).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: 'Remove clip.safetensors' }))
  expect(store.getState().params?.modules).toEqual(['C:\\models\\VAE\\ae.safetensors'])
})

test('size accepts multiples of 8 from 64 to 4096 only', async () => {
  const { store } = renderWithStore(<ParamsPanel />, 'sdxl', open)
  const width = screen.getByRole('spinbutton', { name: en['params.width'] })
  await userEvent.clear(width)
  await userEvent.type(width, '1003')
  expect(store.getState().params?.width).not.toBe(1003)
  await userEvent.clear(width)
  await userEvent.type(width, '1024')
  expect(store.getState().params?.width).toBe(1024)
  await userEvent.clear(width)
  await userEvent.type(width, '8')
  expect(store.getState().params?.width).toBe(1024)
})

test('hires scale reveals second-pass controls and target size', async () => {
  const { store } = renderWithStore(<ParamsPanel />, 'sdxl', open)
  expect(screen.queryByRole('slider', { name: en['params.hiresDenoising'] })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['params.hiresScale']) }))
  await userEvent.click(await screen.findByRole('menuitemradio', { name: '2×' }))
  expect(store.getState().params?.hires?.scale).toBe(2)
  expect(screen.getByText('896×1152 → 1792×2304')).toBeDefined()
  expect(screen.getByRole('slider', { name: en['params.hiresDenoising'] })).toBeDefined()
})

test('img2img exposes denoising and resize controls and hides txt2img hires', async () => {
  const { store } = renderWithStore(<ParamsPanel />, 'sdxl', open)
  act(() => store.getState().setParams({ img2img: { sourceImageId: 7, denoisingStrength: 0.5, resizeMode: 0 } }))
  expect(screen.queryByRole('button', { name: new RegExp(en['params.hiresScale']) })).toBeNull()
  expect(screen.getByRole('slider', { name: en['img2img.denoising'] })).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['img2img.resize']) }))
  await userEvent.click(screen.getByRole('menuitemradio', { name: en['img2img.resize1'] }))
  expect(store.getState().params?.img2img?.resizeMode).toBe(1)
})

test('hires can save its selected upscaler as the default', async () => {
  const save = vi.fn(async () => true)
  const { store } = renderWithStore(<ParamsPanel />, 'sdxl', { ...open, setDefaultUpscaler: save })
  act(() => store.getState().setParams({ hires: {
    scale: 2, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4,
  } }))
  await userEvent.click(screen.getByRole('button', { name: en['viewer.saveUpscalerDefault'] }))
  expect(save).toHaveBeenCalledWith('hires', 'Latent')
  expect(await screen.findByRole('button', { name: en['viewer.upscalerDefaultSaved'] })).toBeDefined()
})

test('hires turns off when a size change would exceed its target limit', () => {
  const { store } = renderWithStore(<ParamsPanel />, 'sdxl', open)
  store.getState().setParams({ width: 512, height: 512 })
  store.getState().setParams({ hires: { scale: 4, upscaler: 'Latent', secondPassSteps: 12, denoisingStrength: 0.4 } })
  expect(store.getState().params?.hires?.scale).toBe(4)
  store.getState().setParams({ height: 1152 })
  expect(store.getState().params?.hires?.scale).toBe(1) // 1152 × 4 exceeds 4096
})

test('Escape closes the panel and returns focus to the All parameters button', async () => {
  const { store } = renderWithStore(
    <>
      <PromptBar />
      <ParamsPanel />
    </>,
    'sdxl',
  )
  expect(screen.queryByRole('complementary')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: en['prompt.allParams'] }))
  expect(screen.getByRole('complementary', { name: en['prompt.allParams'] })).toBeDefined()
  screen.getByRole('slider', { name: en['params.cfg'] }).focus()
  await userEvent.keyboard('{Escape}')
  expect(store.getState().panelOpen).toBe(false)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: en['prompt.allParams'] }))
  await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
})

test('hires presets: a saved one applies all values at once, shows as selected, and a name clash is reported', async () => {
  const saved = { id: 1, name: 'Soft', createdAt: 1,
    settings: { scale: 2 as const, upscaler: 'Latent', secondPassSteps: 9, denoisingStrength: 0.3, cfgScale: 3 } }
  const saveHiresPreset = vi.fn(async () => { throw new Error('error.presetNameTaken') })
  const { store } = renderWithStore(<ParamsPanel />, 'sdxl', { ...open, hiresPresets: [saved], saveHiresPreset })
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['hiresPreset.label']) }))
  await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Soft' }))
  expect(store.getState().params?.hires).toEqual(saved.settings)
  await userEvent.click(screen.getByRole('button', { name: en['hiresPreset.save'] }))
  await userEvent.type(screen.getByRole('textbox', { name: en['hiresPreset.name'] }), 'Soft{Enter}')
  expect(saveHiresPreset).toHaveBeenCalledWith('Soft', saved.settings)
  expect(await screen.findByText(en['hiresPreset.taken'])).toBeDefined()
})
