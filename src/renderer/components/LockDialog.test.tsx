import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Api, AppEvents } from '@shared/ipc'
import type { ImageRecord, LockState } from '@shared/types'
import { en } from '../locales/en'
import { createAppStore } from '../state/store'
import { StoreProvider } from '../state/StoreProvider'
import { Gallery } from './Gallery'
import { LockDialog } from './LockDialog'
import { TopBar } from './TopBar'

const image = (id: number, over: Partial<ImageRecord> = {}): ImageRecord => ({
  id, jobId: id, url: `fnc-img://local/${id}.png`, thumbUrl: `fnc-img://local/t${id}.jpg`, width: 832, height: 1216,
  seed: 1, infotext: '', createdAt: id, durationMs: 1000, hidden: false, sourceImageId: null, tags: [], locked: false, ...over,
})
const locked = (id: number): ImageRecord =>
  image(id, { jobId: 0, hidden: true, url: '', thumbUrl: '', seed: 0, locked: true })

function setup(lock: LockState, pages: ImageRecord[][]) {
  const handlers = new Map<string, Array<(payload: never) => void>>()
  const emit = <K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void => {
    for (const cb of handlers.get(event) ?? []) cb(payload as never)
  }
  const list = vi.fn(async (): Promise<ImageRecord[]> => pages.shift() ?? [])
  const api = {
    settings: { get: vi.fn(async () => ({ serverUrl: null, imagesDir: '', localUrl: '' })) },
    servers: { list: vi.fn(async () => []), addLocal: vi.fn(async () => false) },
    negativePresets: { list: vi.fn(async () => []) },
    jobs: { listActive: vi.fn(async () => []) },
    connection: { get: vi.fn(async () => ({ state: 'connected', latencyMs: 1, attempts: 0, lastOkAt: 1 })) },
    forge: { capabilities: vi.fn(async () => ({ canRestart: false })), health: vi.fn(async () => ({ unhealthy: false })) },
    images: { list, delete: vi.fn(async () => {}), setHidden: vi.fn(async (_ids: number[], _hidden: boolean) => {}) },
    lock: {
      state: vi.fn(async () => lock),
      // Main pushes the new state after each change.
      open: vi.fn(async (_password: string) => emit('lock', { hasPassword: true, open: true })),
      close: vi.fn(async () => emit('lock', { hasPassword: true, open: false })),
      setPassword: vi.fn(async (_old: string | null, _next: string) => emit('lock', { hasPassword: true, open: false })),
    },
    on: vi.fn((event: string, cb: (payload: never) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), cb])
      return () => {}
    }),
  }
  const store = createAppStore(api as unknown as Api)
  render(
    <StoreProvider store={store}>
      <TopBar onOpenServer={() => {}} />
      <Gallery />
      <LockDialog />
    </StoreProvider>,
  )
  void store.getState().init()
  return { api, store, emit }
}

const tileOf = async (id: number): Promise<HTMLElement> =>
  (await screen.findByRole('button', { name: new RegExp(`image ${id}\\b`) })).closest('[role="group"]') as HTMLElement

test('with the lock closed a hidden image is a tile without a picture; the password shows it with a label', async () => {
  const { api } = setup({ hasPassword: true, open: false }, [
    [locked(2), image(1)],
    [image(2, { hidden: true }), image(1)],
  ])
  const tile = await tileOf(2)
  expect(tile.querySelector('img')).toBeNull()
  expect(within(tile).queryByText(en['image.hiddenBadge'])).toBeNull()
  expect((await tileOf(1)).querySelector('img')).not.toBeNull()

  await userEvent.click(within(tile).getByRole('button', { name: 'Hidden image 2. Unlock to view' }))
  const dialog = await screen.findByRole('dialog', { name: en['lock.openTitle'] })
  api.lock.open.mockRejectedValueOnce(new Error('error.wrongPassword'))
  await userEvent.type(within(dialog).getByLabelText(en['lock.password']), 'bad-guess')
  await userEvent.click(within(dialog).getByRole('button', { name: en['lock.unlock'] }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe(en['error.wrongPassword'])

  await userEvent.clear(within(dialog).getByLabelText(en['lock.password']))
  await userEvent.type(within(dialog).getByLabelText(en['lock.password']), 'secret-pass{Enter}')
  expect(api.lock.open).toHaveBeenLastCalledWith('secret-pass')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const shown = await tileOf(2)
  await waitFor(() => expect(shown.querySelector('img')?.getAttribute('src')).toBe('fnc-img://local/t2.jpg'))
  expect(within(shown).getByText(en['image.hiddenBadge'])).toBeDefined()
  expect(within(shown).getByRole('button', { name: en['image.unhide'] })).toBeDefined()
})

test('the first hide without a password asks for one (twice), then hides the image', async () => {
  const { api } = setup({ hasPassword: false, open: false }, [[image(1)]])
  const tile = await tileOf(1)
  await userEvent.click(within(tile).getByRole('button', { name: en['image.hide'] }))
  const dialog = await screen.findByRole('dialog', { name: en['lock.setTitle'] })
  expect(api.images.setHidden).not.toHaveBeenCalled()
  const first = within(dialog).getByLabelText(en['lock.password'])
  const repeat = within(dialog).getByLabelText(en['lock.repeat'])
  expect(first.getAttribute('type')).toBe('password')
  await userEvent.type(first, 'abc')
  await userEvent.type(repeat, 'abc')
  await userEvent.click(within(dialog).getByRole('button', { name: en['lock.save'] }))
  expect(within(dialog).getByRole('alert').textContent).toBe(en['lock.tooShort'])
  await userEvent.type(first, 'def')
  await userEvent.click(within(dialog).getByRole('button', { name: en['lock.save'] }))
  expect(within(dialog).getByRole('alert').textContent).toBe(en['lock.mismatch'])
  await userEvent.type(repeat, 'def')
  await userEvent.click(within(dialog).getByRole('button', { name: en['lock.save'] }))
  expect(api.lock.setPassword).toHaveBeenCalledWith(null, 'abcdef')
  await waitFor(() => expect(api.images.setHidden).toHaveBeenCalledWith([1], true))
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('the lock button: unlock asks for the password, lock closes at once, change needs the current one', async () => {
  const { api } = setup({ hasPassword: true, open: false }, [[image(1)]])
  await userEvent.click(await screen.findByRole('button', { name: en['lock.unlockHidden'] }))
  const dialog = await screen.findByRole('dialog', { name: en['lock.openTitle'] })
  await userEvent.type(within(dialog).getByLabelText(en['lock.password']), 'secret-pass{Enter}')
  await userEvent.click(await screen.findByRole('button', { name: en['lock.lockHidden'] }))
  expect(api.lock.close).toHaveBeenCalled()

  await userEvent.click(await screen.findByRole('button', { name: en['lock.unlockHidden'] }))
  await userEvent.click(await screen.findByRole('button', { name: en['lock.change'] }))
  const change = await screen.findByRole('dialog', { name: en['lock.changeTitle'] })
  await userEvent.type(within(change).getByLabelText(en['lock.current']), 'secret-pass')
  await userEvent.type(within(change).getByLabelText(en['lock.new']), 'next-pass')
  await userEvent.type(within(change).getByLabelText(en['lock.repeatNew']), 'next-pass{Enter}')
  expect(api.lock.setPassword).toHaveBeenCalledWith('secret-pass', 'next-pass')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

test('with no password the lock button offers to set one', async () => {
  setup({ hasPassword: false, open: false }, [[image(1)]])
  await userEvent.click(await screen.findByRole('button', { name: en['lock.setUp'] }))
  expect(await screen.findByRole('dialog', { name: en['lock.setTitle'] })).toBeDefined()
})

test('closing the dialog gives the focus back to the button that opened it', async () => {
  setup({ hasPassword: true, open: false }, [[image(1)]])
  const button = await screen.findByRole('button', { name: en['lock.unlockHidden'] })
  await userEvent.click(button)
  const dialog = await screen.findByRole('dialog', { name: en['lock.openTitle'] })
  expect(document.activeElement).toBe(within(dialog).getByLabelText(en['lock.password']))
  await userEvent.click(within(dialog).getByRole('button', { name: en['lock.cancel'] }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(button)
})
