import { act, screen } from '@testing-library/react'
import { defaultParams } from '@shared/profiles'
import type { Catalog } from '@shared/types'
import { en } from '../locales/en'
import { HiresDialog } from './HiresDialog'
import { catalog, renderWithStore } from './test-store'

const params = { ...defaultParams('sdxl', 'sdxl.safetensors', catalog), width: 832, height: 1216 }

afterEach(() => vi.unstubAllGlobals())

test('Send to hires opens without a catalog (Forge offline) instead of crashing the window', async () => {
  const details = vi.fn(async () => ({ image: { id: 7 }, params, jobType: 'txt2img' }))
  vi.stubGlobal('api', { images: { details } })
  renderWithStore(<HiresDialog />, 'sdxl', { catalog: null, hiresFor: 7 })
  expect(await screen.findByText(en['hires.title'])).toBeDefined()
  await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1))
})

test('the form being edited is not reset when the catalog is replaced under it', async () => {
  const details = vi.fn(async () => ({ image: { id: 7 }, params, jobType: 'txt2img' }))
  vi.stubGlobal('api', { images: { details } })
  const { store } = renderWithStore(<HiresDialog />, 'sdxl', { catalog: { ...catalog, upscalers: ['Latent'] } as Catalog, hiresFor: 7 })
  await vi.waitFor(() => expect(details).toHaveBeenCalledTimes(1))
  act(() => store.setState({ catalog: { ...catalog, upscalers: ['Latent', 'R-ESRGAN 4x+'] } as Catalog }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(details).toHaveBeenCalledTimes(1)
})
