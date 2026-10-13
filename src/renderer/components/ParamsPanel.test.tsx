import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '../locales/en'
import { ParamsPanel } from './ParamsPanel'
import { PromptBar } from './PromptBar'
import { renderWithStore } from './test-store'

const open = { panelOpen: true }
const row = (name: string) => screen.queryByRole('spinbutton', { name })

test('sdxl shows CFG and Clip skip, hides Distilled CFG and Shift', () => {
  renderWithStore(<ParamsPanel />, 'sdxl', open)
  expect(row(en['params.cfg'])).not.toBeNull()
  expect(row(en['params.clipSkip'])).not.toBeNull()
  expect(row(en['params.distilledCfg'])).toBeNull()
  expect(row(en['params.shift'])).toBeNull()
})

test('krea2 shows Distilled CFG, hides CFG and Clip skip', () => {
  renderWithStore(<ParamsPanel />, 'krea2', open)
  expect(row(en['params.distilledCfg'])).not.toBeNull()
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
  await userEvent.click(screen.getByRole('spinbutton', { name: en['params.cfg'] }))
  await userEvent.keyboard('{Escape}')
  expect(store.getState().panelOpen).toBe(false)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: en['prompt.allParams'] }))
  await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull())
})
