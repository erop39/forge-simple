import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultParams } from '@shared/profiles'
import type { Job, ServerInfo } from '@shared/types'
import { en } from '../locales/en'
import type { AppState } from '../state/store'
import { ServerDialog } from './ServerDialog'
import { renderWithStore } from './test-store'

const home: ServerInfo = { id: 1, name: 'Home', url: 'http://100.64.0.1:7860', active: true }
const studio: ServerInfo = { id: 2, name: 'Studio', url: 'http://100.64.0.2:7860', active: false }
const ok = { ok: true, latencyMs: 5, errorKey: null }

const runningJob: Job = {
  id: 9, serverId: 1, type: 'txt2img', status: 'running',
  params: defaultParams('sdxl', 'a.safetensors', { samplers: [], schedulers: [] }), error: null,
  createdAt: 1, finishedAt: null, durationMs: null, stepsPerSec: null, peakVram: null,
}

function setup(state: Partial<AppState> = {}) {
  const actions = {
    addServer: vi.fn(async () => ok),
    updateServer: vi.fn(async () => ok),
    removeServer: vi.fn(async () => {}),
    activateServer: vi.fn(async () => {}),
  }
  const onOpenChange = vi.fn()
  renderWithStore(<ServerDialog open onOpenChange={onOpenChange} />, 'sdxl', {
    settings: { serverUrl: home.url, imagesDir: '' },
    servers: [home, studio],
    ...actions,
    ...state,
  })
  return { ...actions, onOpenChange }
}

const row = (name: string) => screen.getByRole('listitem', { name })

test('the list shows each server with its address; the active one is marked with an icon and text', () => {
  setup()
  const list = screen.getByRole('list', { name: en['server.list'] })
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  const address = within(row('Home')).getByText(home.url)
  expect(address.classList.contains('mono')).toBe(true)
  expect(within(row('Home')).getByText(en['server.active'])).toBeDefined()
  expect(row('Home').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  expect(within(row('Home')).queryByRole('button', { name: en['server.use'] })).toBeNull()
  expect(within(row('Studio')).queryByText(en['server.active'])).toBeNull()
})

test('Use activates that server', async () => {
  const { activateServer } = setup()
  await userEvent.click(within(row('Studio')).getByRole('button', { name: en['server.use'] }))
  expect(activateServer).toHaveBeenCalledWith(2)
})

test('while a job runs Use is disabled and the reason is given', () => {
  setup({ jobs: { 9: runningJob } })
  const use = within(row('Studio')).getByRole('button', { name: en['server.use'] }) as HTMLButtonElement
  expect(use.disabled).toBe(true)
  const hint = document.getElementById(use.getAttribute('aria-describedby')!)
  expect(hint?.textContent).toBe(en['server.busy'])
})

test('a refused switch shows the mapped error', async () => {
  const { activateServer } = setup()
  activateServer.mockRejectedValueOnce(new Error('error.jobRunning'))
  await userEvent.click(within(row('Studio')).getByRole('button', { name: en['server.use'] }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.jobRunning'])
})

test('Edit opens the form filled in; Save updates and returns to the list', async () => {
  const { updateServer } = setup()
  await userEvent.click(screen.getByRole('button', { name: 'Edit Studio' }))
  const name = screen.getByRole('textbox', { name: en['server.name'] }) as HTMLInputElement
  const address = screen.getByRole('textbox', { name: en['server.address'] }) as HTMLInputElement
  expect(name.value).toBe('Studio')
  expect(address.value).toBe(studio.url)
  await userEvent.clear(name)
  await userEvent.type(name, 'Office')
  await userEvent.click(screen.getByRole('button', { name: en['server.save'] }))
  expect(updateServer).toHaveBeenCalledWith(2, { name: 'Office', url: studio.url })
  expect(await screen.findByRole('list', { name: en['server.list'] })).toBeDefined()
})

test('Delete asks first: Keep leaves the server, Delete removes it', async () => {
  const { removeServer } = setup()
  await userEvent.click(screen.getByRole('button', { name: 'Delete Studio' }))
  expect(screen.getByText('Delete Studio? Its queued jobs are removed. Images stay.')).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['server.deleteNo'] }))
  expect(removeServer).not.toHaveBeenCalled()
  expect(screen.queryByText(/Its queued jobs are removed/)).toBeNull()

  await userEvent.click(screen.getByRole('button', { name: 'Delete Studio' }))
  await userEvent.click(screen.getByRole('button', { name: en['server.deleteYes'] }))
  expect(removeServer).toHaveBeenCalledWith(2)
})

test('Add server opens an empty form; Connect saves it and returns to the list; Cancel goes back', async () => {
  const { addServer } = setup()
  await userEvent.click(screen.getByRole('button', { name: en['server.add'] }))
  await userEvent.click(screen.getByRole('button', { name: en['server.cancel'] }))
  expect(screen.getByRole('list', { name: en['server.list'] })).toBeDefined()

  await userEvent.click(screen.getByRole('button', { name: en['server.add'] }))
  const address = screen.getByRole('textbox', { name: en['server.address'] }) as HTMLInputElement
  expect(address.value).toBe('')
  await userEvent.type(screen.getByRole('textbox', { name: en['server.name'] }), 'Laptop')
  await userEvent.type(address, '100.64.0.3:7860')
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  expect(addServer).toHaveBeenCalledWith({ name: 'Laptop', url: '100.64.0.3:7860' })
  await waitFor(() => expect(screen.getByRole('list', { name: en['server.list'] })).toBeDefined())
})

test('a duplicate address is reported under the form', async () => {
  const { addServer } = setup()
  addServer.mockRejectedValueOnce(new Error('error.duplicateServer'))
  await userEvent.click(screen.getByRole('button', { name: en['server.add'] }))
  await userEvent.type(screen.getByRole('textbox', { name: en['server.address'] }), home.url)
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.duplicateServer'])
})

test('with saved servers but none active, the list shows and cannot be dismissed', () => {
  setup({ settings: { serverUrl: null, imagesDir: '' }, servers: [{ ...home, active: false }] })
  expect(screen.getByRole('list', { name: en['server.list'] })).toBeDefined()
  expect(screen.queryByRole('button', { name: en['server.close'] })).toBeNull()
  expect(within(row('Home')).getByRole('button', { name: en['server.use'] })).toBeDefined()
})
