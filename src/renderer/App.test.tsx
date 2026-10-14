import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Api, ConnectionCheck } from '@shared/ipc'
import { defaultParams } from '@shared/profiles'
import type { Catalog } from '@shared/types'
import { App } from './App'
import { en } from './locales/en'
import { createAppStore } from './state/store'
import { StoreProvider } from './state/StoreProvider'

const catalog: Catalog = {
  checkpoints: [{ title: 'a.safetensors', name: 'a', filename: 'a.safetensors', family: 'sdxl' }],
  modules: [], loras: [], samplers: [], schedulers: [], upscalers: [], loadedCheckpoint: null, fetchedAt: 1, familyModules: {},
}

function setup(serverUrl: string | null, setServerUrl?: () => Promise<ConnectionCheck>, catalogFails = false) {
  const api = {
    settings: {
      get: vi.fn(async () => ({ serverUrl, imagesDir: '' })),
      setServerUrl: vi.fn(setServerUrl ?? (async () => ({ ok: true, latencyMs: 5, errorKey: null }))),
    },
    catalog: {
      get: vi.fn(async () => catalog),
      defaults: vi.fn(async () => defaultParams('sdxl', 'a.safetensors', { samplers: [], schedulers: [] })),
      parts: vi.fn(async () => []),
    },
    jobs: { enqueue: vi.fn(), cancel: vi.fn(), retry: vi.fn(), listActive: vi.fn(async () => []) },
    images: { list: vi.fn(async () => []), delete: vi.fn() },
    connection: { get: vi.fn(async () => ({ state: 'connected', latencyMs: 38, attempts: 0, lastOkAt: 1 })) },
    on: vi.fn(() => () => {}),
  }
  if (catalogFails) api.catalog.get.mockRejectedValueOnce(new Error('error.network'))
  const store = createAppStore(api as unknown as Api)
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  )
  return { api, store }
}

const dialog = () => screen.queryByRole('dialog')

test('with no server the dialog opens by itself and the empty state sits behind it', async () => {
  setup(null)
  expect(await screen.findByRole('dialog', { name: en['server.title'] })).toBeDefined()
  expect(document.body.textContent).toContain(en['empty.noServer.title'])
  expect(document.body.textContent).toContain(en['empty.noServer.body'])
})

test('with no server, Escape does not dismiss and there is no close button', async () => {
  setup(null)
  await screen.findByRole('dialog')
  await userEvent.keyboard('{Escape}')
  expect(dialog()).not.toBeNull()
  expect(screen.queryByRole('button', { name: en['server.close'] })).toBeNull()
})

test('with a server the dialog is closed, opens from the chip and the gear, and Escape closes it', async () => {
  setup('http://127.0.0.1:7861')
  await screen.findByRole('button', { name: new RegExp(en['connection.connected']) })
  expect(dialog()).toBeNull()

  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['connection.connected']) }))
  expect(await screen.findByRole('dialog')).toBeDefined()
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(dialog()).toBeNull())

  await userEvent.click(screen.getByRole('button', { name: en['topbar.settings'] }))
  expect(await screen.findByRole('dialog')).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['server.close'] }))
  await waitFor(() => expect(dialog()).toBeNull())
})

test('a successful connect closes the dialog', async () => {
  const { api } = setup(null)
  const input = await screen.findByRole('textbox', { name: en['server.address'] })
  api.settings.get.mockResolvedValue({ serverUrl: 'http://127.0.0.1:7861', imagesDir: '' })
  await userEvent.type(input, '127.0.0.1:7861')
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  await waitFor(() => expect(dialog()).toBeNull())
  expect(api.settings.setServerUrl).toHaveBeenCalledWith('127.0.0.1:7861')
})

test('a failed connect shows the mapped error under the field and refocuses it', async () => {
  const { api } = setup(null, async () => ({ ok: false, latencyMs: null, errorKey: 'error.notForge' }))
  const input = await screen.findByRole('textbox', { name: en['server.address'] })
  await userEvent.type(input, '127.0.0.1:1')
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe(en['error.notForge'])
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(dialog()).not.toBeNull()
  expect(api.settings.setServerUrl).toHaveBeenCalledTimes(1)
})

test('a rejected connect is mapped through the catalog, never shown raw', async () => {
  setup(null, async () => {
    throw new Error('error.invalidParams')
  })
  const input = await screen.findByRole('textbox', { name: en['server.address'] })
  await userEvent.type(input, 'x')
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.invalidParams'])
})

test('while connecting the button is disabled and shows progress', async () => {
  let release: (c: ConnectionCheck) => void = () => {}
  setup(null, () => new Promise<ConnectionCheck>((resolve) => { release = resolve }))
  const input = await screen.findByRole('textbox', { name: en['server.address'] })
  await userEvent.type(input, '127.0.0.1:7861')
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  const busy = await screen.findByRole('button', { name: en['server.connecting'] })
  expect((busy as HTMLButtonElement).disabled).toBe(true)
  release({ ok: false, latencyMs: null, errorKey: 'error.network' })
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.network'])
})

test('a failed user action shows a dismissible notice', async () => {
  const { store } = setup('http://127.0.0.1:7861')
  await screen.findByRole('button', { name: new RegExp(en['connection.connected']) })
  store.setState({ lastError: 'error.noServer' })
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain(en['error.noServer'])
  await userEvent.click(screen.getByRole('button', { name: en['notice.dismiss'] }))
  expect(screen.queryByRole('alert')).toBeNull()
})

test('with no server the chip reads No server, not Reconnecting', async () => {
  setup(null)
  await screen.findByRole('dialog')
  expect(document.body.textContent).toContain(en['connection.none'])
  expect(document.body.textContent).not.toContain(en['connection.reconnecting'])
})

test('a refresh failure after an ok check leaves the form usable with an error', async () => {
  const { api } = setup(null)
  const input = await screen.findByRole('textbox', { name: en['server.address'] })
  api.settings.get.mockRejectedValue(new Error('error.unexpected'))
  await userEvent.type(input, '127.0.0.1:7861')
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.unexpected'])
  const button = screen.getByRole('button', { name: en['server.connect'] }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  expect((input as HTMLInputElement).readOnly).toBe(false)
})

test('the input and the dialog are both described, with distinct ids', async () => {
  setup(null)
  const input = await screen.findByRole('textbox', { name: en['server.address'] })
  const dlg = screen.getByRole('dialog')
  const hint = document.getElementById(input.getAttribute('aria-describedby')!.split(' ')[0]!)
  expect(hint?.textContent).toBe(en['server.hint'])
  expect(dlg.getAttribute('aria-describedby')).toBeTruthy()
  expect(document.getElementById(dlg.getAttribute('aria-describedby')!)?.textContent).toContain(en['server.hint'])
})

test('a catalog failure shows a notice; Retry reloads and removes it', async () => {
  const { api, store } = setup('http://127.0.0.1:7861', undefined, true)
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain(en['error.network'])
  await userEvent.click(screen.getByRole('button', { name: en['catalog.retry'] }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(api.catalog.get).toHaveBeenLastCalledWith(true)
  expect(store.getState().params?.checkpoint).toBe('a.safetensors')
})
