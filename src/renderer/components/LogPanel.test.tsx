import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultParams } from '@shared/profiles'
import type { ImageRecord, Job, OplogEntry } from '@shared/types'
import { en } from '../locales/en'
import type { AppState } from '../state/store'
import { LogPanel } from './LogPanel'
import { TopBar } from './TopBar'
import { renderWithStore } from './test-store'

const entry = (id: number, over: Partial<OplogEntry> = {}): OplogEntry => ({
  id, time: Date.UTC(2026, 9, 14, 12, 0, id), level: 'info', category: 'app', messageKey: 'log.app.started',
  durationMs: null, jobId: null, details: { version: '0.1.0' }, ...over,
})
const finished = entry(3, {
  category: 'generation', messageKey: 'log.generation.finished', durationMs: 41_234, jobId: 7,
  details: { width: 832, height: 1216, steps: 28, seed: 5 },
})
const failedEntry = entry(2, {
  level: 'error', category: 'error', messageKey: 'log.error.generation', jobId: 6, details: { kind: 'http', status: 500 },
})
const started = entry(1)

const params = defaultParams('sdxl', 'a.safetensors', { samplers: [], schedulers: [] })
const failedJob: Job = {
  id: 6, serverId: 1, type: 'txt2img', status: 'failed', params,
  error: { code: 'forgeHttp', status: 500, detail: 'TypeError: model is None' },
  createdAt: 1, finishedAt: 2, durationMs: null, stepsPerSec: null, peakVram: null,
}
const image7: ImageRecord = {
  id: 70, jobId: 7, url: 'fnc-img://local/70.png', thumbUrl: 'fnc-img://local/t70.jpg', width: 832, height: 1216,
  seed: 5, infotext: '', createdAt: 1, durationMs: 41_000, hidden: false, sourceImageId: null,
}

function setup(state: Partial<AppState> = {}) {
  const actions = {
    setLogFilters: vi.fn(),
    exportLog: vi.fn(async () => true),
    logRetention: vi.fn(async () => 90),
    setLogRetention: vi.fn(async () => {}),
    getJob: vi.fn(async (id: number): Promise<Job> => (id === 6 ? failedJob : { ...failedJob, id, status: 'done', error: null })),
  }
  const rendered = renderWithStore(<LogPanel />, 'sdxl', {
    logOpen: true, logEntries: [finished, failedEntry, started], ...actions, ...state,
  })
  return { ...rendered, ...actions, ...state }
}

const rows = () => within(screen.getByRole('list', { name: en['logPanel.entries'] })).getAllByRole('listitem')

test('the top bar button opens the panel; Escape and the close button close it', async () => {
  const { store } = renderWithStore(
    <>
      <TopBar onOpenServer={() => {}} />
      <LogPanel />
    </>,
    'sdxl',
    { logRetention: async () => 90 },
  )
  store.setState({ toggleLog: () => store.setState((s) => ({ logOpen: !s.logOpen })) })
  const button = screen.getByRole('button', { name: en['topbar.log'] })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  await userEvent.click(button)
  expect(screen.getByRole('complementary', { name: en['logPanel.title'] })).toBeDefined()
  expect(button.getAttribute('aria-expanded')).toBe('true')
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('complementary', { name: en['logPanel.title'] })).toBeNull()
  expect(document.activeElement).toBe(button)
  await userEvent.click(button)
  await userEvent.click(screen.getByRole('button', { name: en['logPanel.close'] }))
  expect(store.getState().logOpen).toBe(false)
})

test('rows come newest first with time, level icon and word, category, catalog text and a mono duration', () => {
  setup()
  const [first, second, third] = rows() as [HTMLElement, HTMLElement, HTMLElement]
  const time = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  expect(within(first).getByText(time.format(finished.time))).toBeDefined()
  expect(within(first).getByText('Generation finished: 832×1216, 28 steps, seed 5.')).toBeDefined()
  expect(within(first).getByText(en['logPanel.category.generation'])).toBeDefined()
  const duration = within(first).getByText('41.2 s')
  expect(duration.classList.contains('mono')).toBe(true)
  const level = within(second).getByText(en['logPanel.level.error'])
  expect(level.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  expect(within(second).getByText(en['log.error.generation'])).toBeDefined()
  expect(within(third).getByText('App started (version 0.1.0).')).toBeDefined()
})

test('the level, category and period filters go to the store', async () => {
  const { setLogFilters } = setup()
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['logPanel.allLevels']) }))
  await userEvent.click(await screen.findByRole('menuitemradio', { name: en['logPanel.level.error'] }))
  expect(setLogFilters).toHaveBeenCalledWith({ level: 'error' })
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['logPanel.allCategories']) }))
  await userEvent.click(await screen.findByRole('menuitemradio', { name: en['logPanel.category.server'] }))
  expect(setLogFilters).toHaveBeenCalledWith({ category: 'server' })
  await userEvent.click(screen.getByRole('button', { name: new RegExp(en['logPanel.period.24h']) }))
  for (const period of ['1h', '7d', 'all'] as const) {
    expect(await screen.findByRole('menuitemradio', { name: en[`logPanel.period.${period}`] })).toBeDefined()
  }
  await userEvent.click(screen.getByRole('menuitemradio', { name: en['logPanel.period.1h'] }))
  expect(setLogFilters).toHaveBeenCalledWith({ period: '1h' })
})

test('the search matches the shown text, not the message key', async () => {
  setup()
  await userEvent.type(screen.getByRole('searchbox', { name: en['logPanel.search'] }), 'version 0.1')
  expect(rows()).toHaveLength(1)
  await userEvent.clear(screen.getByRole('searchbox'))
  await userEvent.type(screen.getByRole('searchbox'), 'log.app')
  expect(screen.queryByRole('listitem')).toBeNull()
  expect(screen.getByText(en['logPanel.empty'])).toBeDefined()
})

test('new entries in the store show up at the top', async () => {
  const { store } = setup()
  act(() => store.setState((s) => ({ logEntries: [entry(9, { messageKey: 'log.queue.resumed', details: {} }), ...s.logEntries] })))
  expect(within(rows()[0]!).getByText(en['log.queue.resumed'])).toBeDefined()
})

test('clicking the event of a failed job shows the stored error of that job; a second click hides it', async () => {
  const { getJob } = setup()
  const button = within(rows()[1]!).getByRole('button')
  await userEvent.click(button)
  expect(getJob).toHaveBeenCalledWith(6)
  expect(await screen.findByText('Job 6: failed')).toBeDefined()
  expect(screen.getByText('Forge returned an error (500).')).toBeDefined()
  expect(screen.getByText('Code: forgeHttp · HTTP 500')).toBeDefined()
  expect(screen.getByText('TypeError: model is None')).toBeDefined()
  expect(button.getAttribute('aria-expanded')).toBe('true')
  await userEvent.click(button)
  expect(screen.queryByText('Job 6: failed')).toBeNull()
})

test('clicking the event of a finished job asks the gallery to open its image when it is loaded', async () => {
  const { store } = setup({ images: [image7] })
  await userEvent.click(within(rows()[0]!).getByRole('button'))
  await waitFor(() => expect(store.getState().viewRequest).toBe(70))
})

test('an event without a job is not clickable; a job that is gone says so', async () => {
  const getJob = vi.fn(async (): Promise<Job> => { throw new Error('error.notFound') })
  setup({ getJob })
  expect(within(rows()[2]!).queryByRole('button')).toBeNull()
  await userEvent.click(within(rows()[1]!).getByRole('button'))
  expect(await screen.findByText(en['logPanel.jobGone'])).toBeDefined()
})

test('Export reports the result; Keep for shows and saves the retention; the Forge console note is there', async () => {
  const { exportLog, setLogRetention } = setup()
  await userEvent.click(screen.getByRole('button', { name: en['logPanel.export'] }))
  expect(exportLog).toHaveBeenCalled()
  expect((await screen.findByRole('status')).textContent).toBe(en['logPanel.exported'])
  const days = await screen.findByRole('spinbutton', { name: en['logPanel.keepFor'] })
  expect((days as HTMLInputElement).value).toBe('90')
  await userEvent.clear(days)
  await userEvent.type(days, '30')
  await waitFor(() => expect(setLogRetention).toHaveBeenCalledWith(30))
  expect(setLogRetention).toHaveBeenCalledTimes(1)
  expect(screen.getByText(en['logPanel.forgeConsole'])).toBeDefined()
})

test('a cancelled export shows nothing; a failed one shows the error', async () => {
  const exportLog = vi.fn(async () => false)
  setup({ exportLog })
  await userEvent.click(screen.getByRole('button', { name: en['logPanel.export'] }))
  expect(screen.queryByRole('status')).toBeNull()
  exportLog.mockRejectedValueOnce(new Error('error.unexpected'))
  await userEvent.click(screen.getByRole('button', { name: en['logPanel.export'] }))
  expect((await screen.findByRole('alert')).textContent).toBe(en['error.unexpected'])
})
