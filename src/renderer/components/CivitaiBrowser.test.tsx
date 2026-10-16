import { screen } from '@testing-library/react'
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
  expect(browseCivitai).toHaveBeenCalledWith({ kind: 'lora', period: 'week', sort: 'newest', baseModels: [], text: '', cursor: null })
  expect(screen.getByText(en['browser.have'])).toBeDefined()
  expect(screen.getByText(en['browser.older'])).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['browser.more'] }))
  expect(browseCivitai).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c2' }))
  await userEvent.click(screen.getAllByRole('button', { name: /Detail Tweaker/ })[0]!)
  expect(openCivitaiModel).toHaveBeenCalledWith(1, 10)
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
