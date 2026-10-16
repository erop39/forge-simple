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
    settings: { serverUrl: home.url, imagesDir: '', localUrl: 'http://127.0.0.1:7860' },
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

test('image storage shows the current folder and opens the native picker action', async () => {
  const chooseImagesDir = vi.fn(async () => 'C:\\Pictures\\Forge')
  setup({ settings: { serverUrl: home.url, imagesDir: 'C:\\Pictures\\Old', localUrl: '' }, chooseImagesDir })
  expect(screen.getByText('C:\\Pictures\\Old')).toBeDefined()
  expect(screen.getByText(en['storage.futureOnly'])).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['storage.choose'] }))
  expect(chooseImagesDir).toHaveBeenCalledOnce()
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

test('Add server opens the form; Connect saves it and returns to the list; Cancel goes back', async () => {
  const { addServer } = setup()
  await userEvent.click(screen.getByRole('button', { name: en['server.add'] }))
  await userEvent.click(screen.getByRole('button', { name: en['server.cancel'] }))
  expect(screen.getByRole('list', { name: en['server.list'] })).toBeDefined()

  await userEvent.click(screen.getByRole('button', { name: en['server.add'] }))
  const address = screen.getByRole('textbox', { name: en['server.address'] }) as HTMLInputElement
  const name = screen.getByRole('textbox', { name: en['server.name'] })
  await userEvent.clear(name)
  await userEvent.type(name, 'Laptop')
  await userEvent.clear(address)
  await userEvent.type(address, '100.64.0.3:7860')
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  expect(addServer).toHaveBeenCalledWith({ name: 'Laptop', url: '100.64.0.3:7860' })
  await waitFor(() => expect(screen.getByRole('list', { name: en['server.list'] })).toBeDefined())
})

test('a duplicate address is reported under the form', async () => {
  const { addServer } = setup()
  addServer.mockRejectedValueOnce(new Error('error.duplicateServer'))
  await userEvent.click(screen.getByRole('button', { name: en['server.add'] }))
  await userEvent.clear(screen.getByRole('textbox', { name: en['server.address'] }))
  await userEvent.type(screen.getByRole('textbox', { name: en['server.address'] }), home.url)
  await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.duplicateServer'])
})

describe('this PC', () => {
  const LOCAL = 'http://127.0.0.1:7860'
  const field = (key: 'server.name' | 'server.address') =>
    screen.getByRole('textbox', { name: en[key] }) as HTMLInputElement
  const useThisPc = () => screen.queryByRole('button', { name: en['server.useThisPc'] })

  test('the add form starts with This PC and the local address, and Connect adds it', async () => {
    const { addServer } = setup()
    await userEvent.click(screen.getByRole('button', { name: en['server.add'] }))
    expect(field('server.name').value).toBe(en['server.thisPc'])
    expect(field('server.address').value).toBe(LOCAL)
    expect(useThisPc()).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: en['server.connect'] }))
    expect(addServer).toHaveBeenCalledWith({ name: en['server.thisPc'], url: LOCAL })
  })

  test('the first-run form is filled in the same way', () => {
    setup({ settings: { serverUrl: null, imagesDir: '', localUrl: LOCAL }, servers: [] })
    expect(field('server.name').value).toBe(en['server.thisPc'])
    expect(field('server.address').value).toBe(LOCAL)
  })

  test('both fields stay editable; Use this PC puts the local address back (and the name, when blank)', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: en['server.add'] }))
    await userEvent.clear(field('server.name'))
    await userEvent.clear(field('server.address'))
    await userEvent.type(field('server.address'), '100.64.0.9:7860')
    expect(field('server.address').value).toBe('100.64.0.9:7860')
    await userEvent.click(useThisPc()!)
    expect(field('server.address').value).toBe(LOCAL)
    expect(field('server.name').value).toBe(en['server.thisPc'])
    expect(useThisPc()).toBeNull()
  })

  test('Use this PC keeps a name the user typed', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: en['server.add'] }))
    await userEvent.clear(field('server.name'))
    await userEvent.type(field('server.name'), 'Desk')
    await userEvent.type(field('server.address'), '1')
    await userEvent.click(useThisPc()!)
    expect(field('server.name').value).toBe('Desk')
    expect(field('server.address').value).toBe(LOCAL)
  })

  test('with the local address already saved the add form starts empty and offers no Use this PC', async () => {
    setup({ servers: [home, { ...studio, url: LOCAL }] })
    await userEvent.click(screen.getByRole('button', { name: en['server.add'] }))
    expect(field('server.name').value).toBe('')
    expect(field('server.address').value).toBe('')
    await userEvent.type(field('server.address'), '100.64.0.9:7860')
    expect(useThisPc()).toBeNull()
  })

  test('editing a server is never prefilled and offers no Use this PC', async () => {
    setup()
    await userEvent.click(within(row('Studio')).getByRole('button', { name: en['server.edit'].replace('{name}', 'Studio') }))
    expect(field('server.address').value).toBe(studio.url)
    expect(useThisPc()).toBeNull()
  })
})

test('with saved servers but none active, the list shows and cannot be dismissed', () => {
  setup({ settings: { serverUrl: null, imagesDir: '', localUrl: 'http://127.0.0.1:7860' }, servers: [{ ...home, active: false }] })
  expect(screen.getByRole('list', { name: en['server.list'] })).toBeDefined()
  expect(screen.queryByRole('button', { name: en['server.close'] })).toBeNull()
  expect(within(row('Home')).getByRole('button', { name: en['server.use'] })).toBeDefined()
})

describe('Forge actions', () => {
  const section = () => screen.getByRole('region', { name: 'Forge on Home' })

  test('without --api-server-stop Restart is disabled and the hint says which flag to add', () => {
    setup()
    const restart = within(section()).getByRole('button', { name: en['forge.restart'] })
    expect((restart as HTMLButtonElement).disabled).toBe(true)
    const hint = within(section()).getByText(en['forge.restartHint'])
    expect(restart.getAttribute('aria-describedby')).toBe(hint.id)
  })

  test('Restart asks first; Restart in the confirmation restarts and reports it', async () => {
    const restartForge = vi.fn(async () => 'restarting' as const)
    setup({ capabilities: { canRestart: true }, restartForge })
    await userEvent.click(within(section()).getByRole('button', { name: en['forge.restart'] }))
    expect(within(section()).getByText(en['forge.restartBody'])).toBeDefined()
    expect(restartForge).not.toHaveBeenCalled()
    await userEvent.click(within(section()).getByRole('button', { name: en['forge.restartYes'] }))
    expect(restartForge).toHaveBeenCalledTimes(1)
    expect((await within(section()).findByRole('status')).textContent).toBe(en['forge.restartStarted'])
  })

  test('Unload model unloads and confirms; a refusal shows the error; disabled while a job runs', async () => {
    const unloadModel = vi.fn(async () => {})
    setup({ unloadModel })
    await userEvent.click(within(section()).getByRole('button', { name: en['forge.unload'] }))
    expect(unloadModel).toHaveBeenCalledTimes(1)
    expect((await within(section()).findByRole('status')).textContent).toBe(en['forge.unloaded'])
    unloadModel.mockRejectedValueOnce(new Error('error.network'))
    await userEvent.click(within(section()).getByRole('button', { name: en['forge.unload'] }))
    expect((await within(section()).findByRole('alert')).textContent).toBe(en['error.network'])
  })

  test('Unload is disabled while a job runs', () => {
    setup({ jobs: { 9: runningJob } })
    expect((within(section()).getByRole('button', { name: en['forge.unload'] }) as HTMLButtonElement).disabled).toBe(true)
  })
})

test('settings export reports success; import shows what it would add and writes only after Import', async () => {
  const exportSettings = vi.fn(async () => true)
  const summary = { servers: 1, presets: 2, hiresPresets: 0, negativePresets: 0, models: 0, settings: 0, wishlist: 3, renamed: 1, skipped: 3 }
  const previewSettingsImport = vi.fn(async () => summary)
  const applySettingsImport = vi.fn(async () => summary)
  const discardSettingsImport = vi.fn(async () => undefined)
  setup({ exportSettings, previewSettingsImport, applySettingsImport, discardSettingsImport })
  await userEvent.click(screen.getByRole('button', { name: en['backup.export'] }))
  const picker = await screen.findByRole('group', { name: en['backup.exportTitle'] })
  expect(within(picker).getAllByRole('checkbox')).toHaveLength(7)
  await userEvent.click(within(picker).getByRole('checkbox', { name: en['backup.pick.servers'] }))
  await userEvent.click(within(picker).getByRole('checkbox', { name: en['backup.pick.wishlist'] }))
  await userEvent.click(within(picker).getByRole('button', { name: en['backup.exportDo'] }))
  expect(exportSettings).toHaveBeenCalledWith(['presets', 'hiresPresets', 'negativePresets', 'models', 'settings'])
  expect(await screen.findByText(en['backup.exported'])).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['backup.import'] }))
  const group = await screen.findByRole('group', { name: en['backup.previewTitle'] })
  expect(within(group).getByText('1 servers')).toBeDefined()
  expect(within(group).getByText('2 settings presets')).toBeDefined()
  expect(within(group).getByText('3 Download later models')).toBeDefined()
  expect(within(group).queryByText(/hires presets/)).toBeNull()
  expect(applySettingsImport).not.toHaveBeenCalled()
  await userEvent.click(within(group).getByRole('button', { name: en['backup.cancel'] }))
  expect(discardSettingsImport).toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: en['backup.import'] }))
  const second = await screen.findByRole('group', { name: en['backup.previewTitle'] })
  await userEvent.click(within(second).getByRole('checkbox', { name: '1 servers' }))
  await userEvent.click(within(second).getByRole('button', { name: en['backup.apply'] }))
  expect(applySettingsImport).toHaveBeenCalledWith(['presets', 'wishlist'])
  expect(await screen.findByText(en['backup.done'])).toBeDefined()
})

test('a refused settings file shows the reason and leaves the dialog usable', async () => {
  const previewSettingsImport = vi.fn(async () => { throw new Error('error.backupVersion') })
  setup({ previewSettingsImport })
  await userEvent.click(screen.getByRole('button', { name: en['backup.import'] }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.backupVersion'])
  expect(screen.getByRole('button', { name: en['backup.import'] })).toBeDefined()
})

test('the red delete-all button counts first and deletes only after the second, explicit confirmation', async () => {
  const countGenerations = vi.fn(async () => ({ total: 12, hidden: 0 }))
  const deleteAllGenerations = vi.fn(async () => ({ deleted: 12, failed: 0 }))
  setup({ countGenerations, deleteAllGenerations })
  await userEvent.click(screen.getByRole('button', { name: en['danger.deleteAll'] }))
  const confirm = await screen.findByRole('alertdialog', { name: en['danger.confirmTitle'] })
  expect(within(confirm).getByText(/All 12 images/)).toBeDefined()
  expect(deleteAllGenerations).not.toHaveBeenCalled()
  await userEvent.click(within(confirm).getByRole('button', { name: en['danger.cancel'] }))
  expect(deleteAllGenerations).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: en['danger.deleteAll'] }))
  await userEvent.click(await screen.findByRole('button', { name: en['danger.confirmYes'] }))
  expect(deleteAllGenerations).toHaveBeenCalledOnce()
  expect(await screen.findByText('Deleted 12 images.')).toBeDefined()
})

test('a refused delete-all shows the reason', async () => {
  const deleteAllGenerations = vi.fn(async () => { throw new Error('error.lockedImages') })
  setup({ countGenerations: vi.fn(async () => ({ total: 3, hidden: 1 })), deleteAllGenerations })
  await userEvent.click(screen.getByRole('button', { name: en['danger.deleteAll'] }))
  await userEvent.click(await screen.findByRole('button', { name: en['danger.confirmYes'] }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.lockedImages'])
})

test('the archives list shows each archive, restores an available one and marks a missing folder', async () => {
  const archiveState = vi.fn(async () => ({
    dir: 'D:/fnc-archives',
    archives: [
      { id: 2, name: '2026-10-16-autumn', createdAt: Date.UTC(2026, 9, 16), imageCount: 40, bytes: 80 * 1024 * 1024, available: true },
      { id: 1, name: '2026-09-01-old', createdAt: Date.UTC(2026, 8, 1), imageCount: 5, bytes: 1024 * 1024, available: false },
    ],
  }))
  const restoreArchive = vi.fn(async () => ({ restored: 38, alreadyThere: 2, damaged: 0 }))
  setup({ archiveState, restoreArchive })
  const list = await screen.findByRole('list', { name: en['archives.title'] })
  expect(within(list).getByText(/40 images · 80.0 MB/)).toBeDefined()
  expect(within(list).getByText(en['archives.unavailable'])).toBeDefined()
  await userEvent.click(within(list).getByRole('button', { name: en['archives.restore'] }))
  expect(restoreArchive).toHaveBeenCalledWith(2)
  expect(await screen.findByText('Restored 38 images (2 were already there, 0 damaged and skipped).')).toBeDefined()
})
