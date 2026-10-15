import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Api, ConnectionCheck } from '@shared/ipc'
import { defaultParams } from '@shared/profiles'
import type { Catalog, ServerInfo } from '@shared/types'
import { App } from './App'
import { en } from './locales/en'
import { createAppStore } from './state/store'
import { StoreProvider } from './state/StoreProvider'

const catalog: Catalog = {
  checkpoints: [{ title: 'a.safetensors', name: 'a', filename: 'a.safetensors', family: 'sdxl' }],
  modules: [], loras: [], samplers: [], schedulers: [], upscalers: [], loadedCheckpoint: null, fetchedAt: 1, familyModules: {},
}

function setup(
  serverUrl: string | null, addServer?: () => Promise<ConnectionCheck>, catalogFails = false, served: Catalog = catalog,
  tweak?: (api: FakeApi) => void,
) {
  const saved: ServerInfo[] = serverUrl ? [{ id: 1, name: 'Home', url: serverUrl, active: true }] : []
  const api = {
    settings: {
      get: vi.fn(async () => ({ serverUrl, imagesDir: '', localUrl: 'http://127.0.0.1:7860' })),
    },
    servers: {
      list: vi.fn(async () => saved),
      add: vi.fn(addServer ?? (async () => ({ ok: true, latencyMs: 5, errorKey: null }))),
      update: vi.fn(),
      remove: vi.fn(),
      activate: vi.fn(),
      addLocal: vi.fn(async () => false),
    },
    negativePresets: { list: vi.fn(async () => []), add: vi.fn(), update: vi.fn(), remove: vi.fn() },
    catalog: {
      get: vi.fn(async () => served),
      defaults: vi.fn(async () => defaultParams('sdxl', 'a.safetensors', { samplers: [], schedulers: [] })),
      parts: vi.fn(async () => []),
    },
    jobs: { enqueue: vi.fn(), cancel: vi.fn(), retry: vi.fn(), listActive: vi.fn(async () => []) },
    images: { list: vi.fn(async () => []), delete: vi.fn(), setHidden: vi.fn() },
    lock: {
      state: vi.fn(async () => ({ hasPassword: false, open: false })), open: vi.fn(), close: vi.fn(), setPassword: vi.fn(),
    },
    connection: { get: vi.fn(async () => ({ state: 'connected', latencyMs: 38, attempts: 0, lastOkAt: 1 })) },
    forge: {
      capabilities: vi.fn(async () => ({ canRestart: false })),
      health: vi.fn(async () => ({ unhealthy: false })),
      restart: vi.fn(),
      unload: vi.fn(),
    },
    on: vi.fn(() => () => {}),
  }
  if (catalogFails) api.catalog.get.mockRejectedValueOnce(new Error('error.network'))
  tweak?.(api)
  const store = createAppStore(api as unknown as Api)
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  )
  return { api, store }
}

type FakeApi = ReturnType<typeof setup>['api']

const dialog = () => screen.queryByRole('dialog')

test('with no server the dialog opens by itself and the empty state sits behind it', async () => {
  setup(null)
  expect(await screen.findByRole('dialog', { name: en['server.title'] })).toBeDefined()
  expect(document.body.textContent).toContain(en['empty.noServer.title'])
  expect(document.body.textContent).toContain(en['empty.noServer.body'])
})

test('first run with Forge answering on this PC: it is used and the dialog never opens', async () => {
  const local: ServerInfo = { id: 1, name: en['server.thisPc'], url: 'http://127.0.0.1:7860', active: true }
  // The check resolves only after the first render, as a real loopback ping would.
  let found!: (v: boolean) => void
  const { api } = setup(null, undefined, false, catalog, (fake) => {
    fake.servers.addLocal.mockReturnValueOnce(new Promise<boolean>((resolve) => { found = resolve }))
  })
  await waitFor(() => expect(api.servers.addLocal).toHaveBeenCalledWith(en['server.thisPc']))
  expect(dialog()).toBeNull()
  api.settings.get.mockResolvedValue({ serverUrl: local.url, imagesDir: '', localUrl: local.url })
  api.servers.list.mockResolvedValue([local])
  found(true)
  await waitFor(() => expect(api.catalog.get).toHaveBeenCalled())
  expect(dialog()).toBeNull()
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
  api.settings.get.mockResolvedValue({ serverUrl: 'http://127.0.0.1:7861', imagesDir: '', localUrl: 'http://127.0.0.1:7860' })
  api.servers.list.mockResolvedValue([{ id: 1, name: '127.0.0.1', url: 'http://127.0.0.1:7861', active: true }])
  await userEvent.clear(input)
  await userEvent.type(input, '127.0.0.1:7861')
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  await waitFor(() => expect(dialog()).toBeNull())
  expect(api.servers.add).toHaveBeenCalledWith({ name: en['server.thisPc'], url: '127.0.0.1:7861' })
})

test('a failed connect shows the mapped error under the field and refocuses it', async () => {
  const { api } = setup(null, async () => ({ ok: false, latencyMs: null, errorKey: 'error.notForge' }))
  const input = await screen.findByRole('textbox', { name: en['server.address'] })
  await userEvent.clear(input)
  await userEvent.type(input, '127.0.0.1:1')
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe(en['error.notForge'])
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(dialog()).not.toBeNull()
  expect(api.servers.add).toHaveBeenCalledTimes(1)
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

test('a catalog without checkpoints shows the no-models state; Refresh asks the server again', async () => {
  const { api } = setup('http://127.0.0.1:7861', undefined, false, { ...catalog, checkpoints: [] })
  expect(await screen.findByText(en['empty.noModels.title'])).toBeDefined()
  expect(screen.getByText(en['empty.noModels.body'])).toBeDefined()
  expect(screen.queryByText(en['empty.gallery.title'])).toBeNull()
  api.catalog.get.mockClear()
  await userEvent.click(screen.getByRole('button', { name: en['catalog.refresh'] }))
  expect(api.catalog.get).toHaveBeenCalledTimes(1)
  expect(api.catalog.get).toHaveBeenCalledWith(true)
})

test('with a server and a model the empty gallery invites the first image', async () => {
  setup('http://127.0.0.1:7861')
  expect(await screen.findByText(en['empty.gallery.title'])).toBeDefined()
})

test('the chip shows the active server name', async () => {
  setup('http://127.0.0.1:7861')
  const chip = await screen.findByRole('button', { name: /Home/ })
  expect(chip.textContent).toContain(en['connection.connected'])
})
