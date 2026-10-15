import { Info, Warning, WarningCircle, X } from '@phosphor-icons/react'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { OPLOG_CATEGORIES, OPLOG_LEVELS, type Job, type OplogEntry, type OplogLevel } from '@shared/types'
import { errorText } from '../i18n/error-text'
import { jobErrorText } from '../i18n/job-error-text'
import { logText } from '../i18n/log-text'
import { LOCALE, t, type MessageKey } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import type { LogFilters, LogPeriod } from '../state/store'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { NumberField } from './ui/NumberField'
import { Select } from './ui/Select'
import styles from './LogPanel.module.css'

export const LOG_TOGGLE_ID = 'log-toggle'
const LOG_PANEL_ID = 'log-panel'

const LEVEL_ICONS: Record<OplogLevel, ReactNode> = {
  info: <Info size={16} aria-hidden="true" />,
  warn: <Warning size={16} aria-hidden="true" />,
  error: <WarningCircle size={16} aria-hidden="true" />,
}
const PERIODS: LogPeriod[] = ['1h', '24h', '7d', 'all']
/** The retention field commits every valid keystroke; the setting is saved once typing pauses. */
const RETENTION_SAVE_DELAY_MS = 600
const levelKey = (level: OplogLevel): MessageKey => `logPanel.level.${level}`
const categoryKey = (category: OplogEntry['category']): MessageKey => `logPanel.category.${category}`

const timeFormat = new Intl.DateTimeFormat(LOCALE, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

function Filters() {
  const filters = useAppStore((s) => s.logFilters)
  const setFilters = useAppStore((s) => s.setLogFilters)
  const set = (patch: Partial<LogFilters>) => setFilters(patch)
  return (
    <div className={styles.filters}>
      <Select
        showLabel={false}
        label={t('logPanel.level')}
        value={filters.level}
        options={[
          { value: 'all', label: t('logPanel.allLevels') },
          ...OPLOG_LEVELS.map((level) => ({ value: level, label: t(levelKey(level)) })),
        ]}
        onChange={(level) => set({ level: level as LogFilters['level'] })}
      />
      <Select
        showLabel={false}
        label={t('logPanel.category')}
        value={filters.category}
        options={[
          { value: 'all', label: t('logPanel.allCategories') },
          ...OPLOG_CATEGORIES.map((category) => ({ value: category, label: t(categoryKey(category)) })),
        ]}
        onChange={(category) => set({ category: category as LogFilters['category'] })}
      />
      <Select
        showLabel={false}
        label={t('logPanel.period')}
        value={filters.period}
        options={PERIODS.map((period) => ({ value: period, label: t(`logPanel.period.${period}`) }))}
        onChange={(period) => set({ period: period as LogPeriod })}
      />
    </div>
  )
}

/** Why a logged job failed, read from the job itself (the log never holds Forge's text). */
function JobOutcome({ job }: { job: Job | 'gone' }) {
  if (job === 'gone') return <p className={styles.outcome}>{t('logPanel.jobGone')}</p>
  const error = job.error ?? { code: 'unexpected' as const }
  const { message, detail } = jobErrorText(error)
  const status = job.status === 'interrupted' ? 'logPanel.jobStatus.interrupted' : 'logPanel.jobStatus.failed'
  return (
    <div className={styles.outcome}>
      <p className={styles.outcomeHead}>{t('logPanel.jobError', { id: job.id, status: t(status) })}</p>
      <p className={styles.outcomeText}>{message}</p>
      <p className={`mono ${styles.outcomeMeta}`}>
        {error.status === undefined
          ? t('logPanel.errorCode', { code: error.code })
          : t('logPanel.errorCodeStatus', { code: error.code, status: error.status })}
      </p>
      {detail !== null && <p className={`mono ${styles.outcomeDetail}`}>{detail}</p>}
    </div>
  )
}

function Row({ entry, text }: { entry: OplogEntry; text: string }) {
  const getJob = useAppStore((s) => s.getJob)
  const requestView = useAppStore((s) => s.requestView)
  const images = useAppStore((s) => s.images)
  const [outcome, setOutcome] = useState<Job | 'gone' | null>(null)
  const jobId = entry.jobId

  async function open(): Promise<void> {
    if (jobId === null) return
    if (outcome !== null) {
      setOutcome(null)
      return
    }
    let job: Job
    try {
      job = await getJob(jobId)
    } catch {
      setOutcome('gone')
      return
    }
    if (job.status === 'failed' || job.status === 'interrupted') {
      setOutcome(job)
      return
    }
    // A finished job opens its image when the gallery has it loaded (a locked one cannot open); otherwise nothing happens.
    const image = images.find((i) => !i.locked && i.jobId === jobId)
    if (image) requestView(image.id)
  }

  const body = (
    <>
      <span className={styles.meta}>
        <span className="mono">{timeFormat.format(entry.time)}</span>
        <span className={`${styles.level} ${styles[entry.level]}`}>
          {LEVEL_ICONS[entry.level]}
          {t(levelKey(entry.level))}
        </span>
        <span className={styles.category}>{t(categoryKey(entry.category))}</span>
        {entry.durationMs !== null && (
          <span className={`mono ${styles.duration}`}>
            {t('logPanel.duration', { s: (entry.durationMs / 1000).toFixed(1) })}
          </span>
        )}
      </span>
      <span className={styles.text}>{text}</span>
    </>
  )
  return (
    <li className={styles.entry}>
      {jobId === null ? (
        <div className={styles.row}>{body}</div>
      ) : (
        <button
          type="button"
          className={`${styles.row} ${styles.clickable}`}
          aria-expanded={outcome !== null}
          title={t('logPanel.showJob', { id: jobId })}
          onClick={() => void open()}
        >
          {body}
        </button>
      )}
      {outcome !== null && <JobOutcome job={outcome} />}
    </li>
  )
}

/** `visibleIds`: the rows the text search left, or null when nothing is searched (export then uses the filters). */
function Footer({ visibleIds }: { visibleIds: number[] | null }) {
  const exportLog = useAppStore((s) => s.exportLog)
  const logRetention = useAppStore((s) => s.logRetention)
  const setLogRetention = useAppStore((s) => s.setLogRetention)
  const [days, setDays] = useState<number | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The retention value waiting for its delayed save. */
  const pendingDays = useRef<number | null>(null)

  useEffect(() => {
    let live = true
    logRetention().then((n) => live && setDays(n), () => undefined)
    return () => {
      live = false
      // Closing the panel saves a value still waiting for its delay instead of dropping it.
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = null
      if (pendingDays.current !== null) void setLogRetention(pendingDays.current).catch(() => undefined)
      pendingDays.current = null
    }
  }, [logRetention, setLogRetention])

  async function run(action: () => Promise<string | null>): Promise<void> {
    setStatus(null)
    setError(null)
    try {
      setStatus(await action())
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <footer className={styles.footer}>
      <div className={styles.footerRow}>
        <Button onClick={() => void run(async () => ((await exportLog(visibleIds ?? undefined)) ? t('logPanel.exported') : null))}>
          {t('logPanel.export')}
        </Button>
        {days !== null && (
          <NumberField
            inline
            label={t('logPanel.keepFor')}
            value={days}
            min={1}
            max={3650}
            onCommit={(next) => {
              setDays(next)
              pendingDays.current = next
              if (saveTimer.current) clearTimeout(saveTimer.current)
              saveTimer.current = setTimeout(() => {
                saveTimer.current = null
                pendingDays.current = null
                void run(async () => {
                  await setLogRetention(next)
                  return null
                })
              }, RETENTION_SAVE_DELAY_MS)
            }}
          />
        )}
      </div>
      {status !== null && <p role="status" className={styles.note}>{status}</p>}
      {error !== null && <p role="alert" className={styles.error}>{error}</p>}
      <p className={styles.note}>{t('logPanel.forgeConsole')}</p>
    </footer>
  )
}

/** The operation log, newest first, as a side panel on the right. Esc closes it. */
export function LogPanel() {
  const open = useAppStore((s) => s.logOpen)
  const entries = useAppStore((s) => s.logEntries)
  const toggleLog = useAppStore((s) => s.toggleLog)
  const [search, setSearch] = useState('')
  const listId = useId()

  const close = (): void => {
    toggleLog()
    document.getElementById(LOG_TOGGLE_ID)?.focus()
  }

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      toggleLog()
      document.getElementById(LOG_TOGGLE_ID)?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, toggleLog])

  // The search runs over the text as shown, so it finds what the user reads.
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return entries
      .map((entry) => ({ entry, text: logText(entry) }))
      .filter(({ text }) => needle === '' || text.toLowerCase().includes(needle))
  }, [entries, search])

  if (!open) return null
  return (
    <aside id={LOG_PANEL_ID} aria-label={t('logPanel.title')} className={styles.panel}>
      <header className={styles.head}>
        <h2 className={styles.title}>{t('logPanel.title')}</h2>
        <IconButton label={t('logPanel.close')} icon={<X size={16} />} onClick={close} />
      </header>
      <Filters />
      <input
        type="search"
        className={styles.search}
        aria-label={t('logPanel.search')}
        aria-controls={listId}
        placeholder={t('logPanel.search')}
        value={search}
        spellCheck={false}
        onChange={(e) => setSearch(e.target.value)}
      />
      <ul id={listId} className={styles.list} aria-label={t('logPanel.entries')}>
        {rows.map(({ entry, text }) => (
          <Row key={entry.id} entry={entry} text={text} />
        ))}
      </ul>
      {rows.length === 0 && <p className={styles.empty}>{t('logPanel.empty')}</p>}
      <Footer visibleIds={search.trim() === '' ? null : rows.map(({ entry }) => entry.id)} />
    </aside>
  )
}
