import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CivitaiBrowseItem, CivitaiBrowsePage } from '@shared/types'
import { en } from '../locales/en'
import { CivitaiBrowserDialog } from './CivitaiBrowser'
import { renderWithStore } from './test-store'

const item = (over: Partial<CivitaiBrowseItem>): CivitaiBrowseItem => ({
  modelId: 1, versionId: 10, name: 'Detail Tweaker', versionName: 'v2', baseModel: 'SDXL 1.0', creator: 'maker',
  publishedAt: Date.parse('2026-10-15T10:00:00Z'), downloads: 1200, url: '', thumb: null, inLibrary: null, ...over,
})

test('without consent it asks first and only then lists; cards mark what the library has and open the model', async () => {
  const setCivitaiEnabled = vi.fn(async () => undefined)
  const browseCivitai = vi.fn(async (): Promise<CivitaiBrowsePage> => ({
    items: [item({}), item({ modelId: 2, versionId: 20, name: 'Other', inLibrary: 'have' }), item({ modelId: 3, versionId: 30, name: 'Third', inLibrary: 'older' })],
    next: null,
  }))
  const openCivitaiModel = vi.fn(async () => undefined)
  renderWithStore(<CivitaiBrowserDialog />, 'sdxl', {
    civitaiBrowser: 'lora', setCivitaiEnabled, browseCivitai, openCivitaiModel,
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: false },
  })
  expect(screen.getByText(en['browser.consentBody'])).toBeDefined()
  expect(browseCivitai).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: en['browser.consentAllow'] }))
  expect(setCivitaiEnabled).toHaveBeenCalledWith(true)
})

test('with consent it lists the week by newest, re-queries on a filter change and opens a card', async () => {
  const browseCivitai = vi.fn(async (): Promise<CivitaiBrowsePage> => ({
    items: [item({}), item({ modelId: 2, versionId: 20, name: 'Other', inLibrary: 'have' }), item({ modelId: 3, versionId: 30, name: 'Third', inLibrary: 'older' })],
    next: 'c2',
  }))
  const openCivitaiModel = vi.fn(async () => undefined)
  renderWithStore(<CivitaiBrowserDialog />, 'sdxl', {
    civitaiBrowser: 'lora', browseCivitai, openCivitaiModel,
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: true },
  })
  expect(await screen.findByText('Detail Tweaker')).toBeDefined()
  expect(browseCivitai).toHaveBeenCalledWith({ site: 'com', kind: 'lora', period: 'week', sort: 'newest', baseModels: [], text: '', cursor: null })
  expect(screen.getByText(en['browser.have'])).toBeDefined()
  expect(screen.getByText(en['browser.older'])).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['browser.more'] }))
  expect(browseCivitai).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c2' }))
  await userEvent.click(screen.getAllByRole('button', { name: /Detail Tweaker/ })[0]!)
  expect(openCivitaiModel).toHaveBeenCalledWith(1, 10, 'com')
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['browser.period']) }))
  await userEvent.click(screen.getByRole('menuitemradio', { name: en['browser.period.day'] }))
  expect(browseCivitai).toHaveBeenLastCalledWith(expect.objectContaining({ period: 'day', cursor: null }))
})

test('a failed listing shows the error text instead of cards', async () => {
  const browseCivitai = vi.fn(async (): Promise<CivitaiBrowsePage> => { throw new Error('error.civitaiBusy') })
  renderWithStore(<CivitaiBrowserDialog />, 'sdxl', {
    civitaiBrowser: 'checkpoint', browseCivitai,
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: true },
  })
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.civitaiBusy'])
})

test('Back leaves the browser for the model library it came from', async () => {
  const { store } = renderWithStore(<CivitaiBrowserDialog />, 'sdxl', {
    civitaiBrowser: 'lora', browseCivitai: vi.fn(async (): Promise<CivitaiBrowsePage> => ({ items: [], next: null })),
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: true },
  })
  await userEvent.click(screen.getByRole('button', { name: en['browser.back'] }))
  expect(store.getState().civitaiBrowser).toBeNull()
  expect(store.getState().modelGallery).toBe('lora')
})

test('the Site menu switches to civitai.red: new listing, a notice, pages open there, and the choice is remembered', async () => {
  localStorage.clear()
  const browseCivitai = vi.fn(async (): Promise<CivitaiBrowsePage> => ({ items: [item({})], next: null }))
  const openCivitaiModel = vi.fn(async () => undefined)
  renderWithStore(<CivitaiBrowserDialog />, 'sdxl', {
    civitaiBrowser: 'checkpoint', browseCivitai, openCivitaiModel,
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: true },
  })
  expect(await screen.findByText('Detail Tweaker')).toBeDefined()
  expect(screen.queryByText(en['browser.redNotice'])).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['browser.site']) }))
  await userEvent.click(screen.getByRole('menuitemradio', { name: en['browser.site.red'] }))
  expect(browseCivitai).toHaveBeenLastCalledWith(expect.objectContaining({ site: 'red', cursor: null }))
  expect(await screen.findByText(en['browser.redNotice'])).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: /Detail Tweaker/ }))
  expect(openCivitaiModel).toHaveBeenCalledWith(1, 10, 'red')
  expect(localStorage.getItem('fnc.civitaiSite')).toBe('red')
  localStorage.clear()
})

test('several base models can be ticked at once; the menu stays open and the listing asks for all of them', async () => {
  localStorage.clear()
  const browseCivitai = vi.fn(async (): Promise<CivitaiBrowsePage> => ({ items: [], next: null }))
  renderWithStore(<CivitaiBrowserDialog />, 'sdxl', {
    civitaiBrowser: 'checkpoint', browseCivitai,
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: true },
  })
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['browser.base']) }))
  await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Pony' }))
  await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Illustrious' }))
  expect(screen.getByRole('menuitemcheckbox', { name: 'Pony' }).getAttribute('aria-checked')).toBe('true')
  expect(browseCivitai).toHaveBeenLastCalledWith(expect.objectContaining({ baseModels: ['Pony', 'Illustrious'] }))
  expect(screen.getByText('2 base models')).toBeDefined()
  await userEvent.click(screen.getByRole('menuitem', { name: en['browser.baseClear'] }))
  expect(browseCivitai).toHaveBeenLastCalledWith(expect.objectContaining({ baseModels: [] }))
})

test('the bookmark marks a model for later, the Download later view lists it, and Mark as downloaded removes it', async () => {
  localStorage.clear()
  const browseCivitai = vi.fn(async (): Promise<CivitaiBrowsePage> => ({ items: [item({})], next: null }))
  const addToWishlist = vi.fn(async () => undefined)
  const removeFromWishlist = vi.fn(async () => undefined)
  const openCivitaiModel = vi.fn(async () => undefined)
  const { store } = renderWithStore(<CivitaiBrowserDialog />, 'sdxl', {
    civitaiBrowser: 'lora', browseCivitai, addToWishlist, removeFromWishlist, openCivitaiModel,
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: true },
  })
  await userEvent.click(await screen.findByRole('button', { name: en['later.add'] }))
  expect(addToWishlist).toHaveBeenCalledWith(1, 10)
  const saved = { id: 5, modelId: 1, versionId: 10, kind: 'lora' as const, name: 'Detail Tweaker', versionName: 'v2', baseModel: 'SDXL 1.0', creator: 'maker', site: 'red' as const, thumb: null, addedAt: 1 }
  act(() => store.setState({ wishlist: [saved] }))
  expect(screen.getByRole('button', { name: en['later.remove'] }).getAttribute('aria-pressed')).toBe('true')
  await userEvent.click(screen.getByRole('button', { name: 'Download later (1)' }))
  const list = screen.getByRole('list', { name: en['later.title'] })
  expect(within(list).getByText('Detail Tweaker')).toBeDefined()
  await userEvent.click(within(list).getByRole('button', { name: en['browser.open'] }))
  expect(openCivitaiModel).toHaveBeenCalledWith(1, 10, 'red')
  await userEvent.click(within(list).getByRole('button', { name: en['later.markDownloaded'] }))
  expect(removeFromWishlist).toHaveBeenCalledWith(5)
})

test('a refused bookmark shows the reason', async () => {
  const addToWishlist = vi.fn(async () => { throw new Error('error.wishlistUnknown') })
  renderWithStore(<CivitaiBrowserDialog />, 'sdxl', {
    civitaiBrowser: 'lora', browseCivitai: vi.fn(async (): Promise<CivitaiBrowsePage> => ({ items: [item({})], next: null })), addToWishlist,
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: true },
  })
  await userEvent.click(await screen.findByRole('button', { name: en['later.add'] }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.wishlistUnknown'])
})

test('the base-model menu offers the families of this app, Krea 2 and the Z-Image ones included, under readable names', async () => {
  localStorage.clear()
  const browseCivitai = vi.fn(async (): Promise<CivitaiBrowsePage> => ({ items: [], next: null }))
  renderWithStore(<CivitaiBrowserDialog />, 'sdxl', {
    civitaiBrowser: 'checkpoint', browseCivitai,
    settings: { serverUrl: 'http://forge.test', imagesDir: '', localUrl: '', civitaiEnabled: true },
  })
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['browser.base']) }))
  for (const name of ['Krea 2', 'Krea 2 Turbo', 'Lumina', 'Qwen', 'Anima', 'Illustrious', 'Flux.2 Klein 9B']) {
    expect(screen.getByRole('menuitemcheckbox', { name })).toBeDefined()
  }
  await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Z-Image Turbo' }))
  expect(browseCivitai).toHaveBeenLastCalledWith(expect.objectContaining({ baseModels: ['ZImageTurbo'] }))
})
