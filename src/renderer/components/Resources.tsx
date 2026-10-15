import { useEffect, useState } from 'react'
import { Gauge, X } from '@phosphor-icons/react'
import type { ResourceSample } from '@shared/types'
import { LOCALE, t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import styles from './Resources.module.css'

export function level(used: number | null, total: number | null): 'normal' | 'warn' | 'critical' {
  if (used === null || total === null || total <= 0) return 'normal'
  const ratio = used / total
  return ratio >= 0.97 ? 'critical' : ratio >= 0.9 ? 'warn' : 'normal'
}

const oneDecimal = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const whole = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 })
const none = (): string => t('resources.none')
const gib = (bytes: number | null): string => bytes === null ? none() : t('resources.gib', { value: oneDecimal.format(bytes / 1024 ** 3) })
const percent = (value: number | null): string => value === null ? none() : t('resources.percent', { value: whole.format(value) })

function Sparkline({ samples, value, maximum }: {
  samples: ResourceSample[]; value(sample: ResourceSample): number | null; maximum: number
}) {
  const last = samples.at(-1)?.time ?? 0
  const points = samples.filter((sample) => sample.time >= last - 60_000)
    .map((sample) => ({ t: sample.time, v: value(sample) })).filter((point): point is { t: number; v: number } => point.v !== null)
  if (points.length < 2 || maximum <= 0) return <span className={styles.noChart}>{none()}</span>
  const first = last - 60_000
  const path = points.map(({ t, v }, index) => `${index === 0 ? 'M' : 'L'} ${((t - first) / 60_000 * 100).toFixed(1)} ${(20 - Math.min(1, v / maximum) * 20).toFixed(1)}`).join(' ')
  return <svg className={styles.chart} viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><path d={path} /></svg>
}

const RING_R = 22
const RING_LENGTH = 2 * Math.PI * RING_R

function Ring({ label, ratio, title }: { label: string; ratio: number | null; title?: string }) {
  const used = ratio === null ? null : Math.max(0, Math.min(1, ratio))
  return <div className={styles.gauge} title={title}>
    <div className={styles.ring}>
      <svg viewBox="0 0 56 56" aria-hidden="true">
        <circle className={styles.ringTrack} cx="28" cy="28" r={RING_R} />
        {used !== null && <circle className={styles.ringFill} data-level={level(used, 1)} cx="28" cy="28" r={RING_R}
          strokeDasharray={`${used * RING_LENGTH} ${RING_LENGTH}`} />}
      </svg>
      <span className={`${styles.ringValue} mono`}>{used === null ? none() : percent(used * 100)}</span>
    </div>
    <span>{label}</span>
  </div>
}

function Block({ label, value, samples, read, maximum }: {
  label: string; value: string; samples: ResourceSample[]; read(sample: ResourceSample): number | null; maximum: number
}) {
  const latestTime = samples.at(-1)?.time ?? 0
  const values = samples.filter((sample) => sample.time >= latestTime - 60_000)
    .map(read).filter((item): item is number => item !== null)
  const peak = values.length ? Math.max(...values) : null
  return <section className={styles.section} aria-label={label}>
    <div className={styles.sectionTitle}><span>{label}</span><strong className="mono">{value}</strong></div>
    <Sparkline samples={samples} value={read} maximum={maximum} />
    <div className={styles.peak}>{t('resources.peak')} {maximum === 100 ? percent(peak) : gib(peak)}</div>
  </section>
}

export function Resources({ onOpenServer }: { onOpenServer: () => void }) {
  const [open, setOpen] = useState(false)
  const [unloadState, setUnloadState] = useState<'idle' | 'done' | 'failed'>('idle')
  const resources = useAppStore((s) => s.resources)
  const connection = useAppStore((s) => s.connection)
  const server = useAppStore((s) => s.servers.find((item) => item.active))
  const capabilities = useAppStore((s) => s.capabilities)
  const askRestart = useAppStore((s) => s.askRestart)
  const unloadModel = useAppStore((s) => s.unloadModel)
  const running = useAppStore((s) => Object.values(s.jobs).some((job) => job.status === 'running'))
  const samples = resources.failed || (connection.state !== 'connected' && connection.state !== 'slow') ? [] : resources.samples
  const latest = samples.at(-1) ?? null
  const stats = latest?.stats ?? null
  const memory = latest?.memory ?? null
  const vramUsed = stats?.gpuVramUsed ?? memory?.vramUsed ?? null
  const vramTotal = stats?.gpuVramTotal ?? memory?.vramTotal ?? null
  const ramUsed = stats?.ramUsed ?? memory?.ramUsed ?? null
  const ramTotal = stats?.ramTotal ?? memory?.ramTotal ?? null
  const cpu = stats?.cpuPercent ?? null
  const gpu = stats?.gpuUtilization ?? null
  const cacheUsed = memory && memory.reserved !== null && memory.allocated !== null
    ? Math.max(0, memory.reserved - memory.allocated) : null
  const modelShare = memory?.allocated !== null && memory?.allocated !== undefined && vramTotal
    ? Math.min(100, memory.allocated / vramTotal * 100) : 0
  const cacheShare = cacheUsed !== null && vramTotal
    ? Math.min(100 - modelShare, cacheUsed / vramTotal * 100) : 0
  const vramRatio = vramUsed !== null && vramTotal ? vramUsed / vramTotal : null
  const ramRatio = ramUsed !== null && ramTotal ? ramUsed / ramTotal : null
  const temperature = stats?.gpuTemperature === null || stats?.gpuTemperature === undefined
    ? none() : t('resources.celsius', { value: whole.format(stats.gpuTemperature) })

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  async function unload(): Promise<void> {
    setUnloadState('idle')
    try { await unloadModel(); setUnloadState('done') }
    catch { setUnloadState('failed') }
  }

  return <div className={styles.root}>
    <IconButton label={t('resources.open')} icon={<Gauge size={20} />} aria-expanded={open}
      onClick={() => setOpen((value) => !value)} />
    {open && <section className={styles.panel} aria-label={t('resources.title')}>
      <div className={styles.head}>
        <span className={styles.title}>{t('resources.title')}</span>
        <IconButton label={t('resources.close')} icon={<X size={20} />} onClick={() => setOpen(false)} />
      </div>
      <div className={styles.gauges}>
        <Ring label={t('resources.vram')} ratio={vramRatio} />
        <Ring label={t('resources.ram')} ratio={ramRatio} title={stats ? undefined : t('resources.forgeProcessRam')} />
        <Ring label={t('resources.cpu')} ratio={cpu === null ? null : cpu / 100} />
        <Ring label={t('resources.gpu')} ratio={gpu === null ? null : gpu / 100} />
      </div>
      <Block label={t('resources.vram')} value={`${gib(vramUsed)} / ${gib(vramTotal)}`} samples={samples}
        read={(sample) => sample.stats?.gpuVramUsed ?? sample.memory.vramUsed} maximum={vramTotal ?? 0} />
      <div className={styles.vramTrack} role="img" aria-label={t('resources.vramBreakdown', { model: gib(memory?.allocated ?? null), cache: gib(cacheUsed) })}>
        <span className={styles.modelFill} style={{ width: `${modelShare}%` }} />
        <span className={styles.cacheFill} style={{ width: `${cacheShare}%` }} />
      </div>
      <Block label={t('resources.ram')} value={`${gib(ramUsed)} / ${gib(ramTotal)}`} samples={samples}
        read={(sample) => sample.stats?.ramUsed ?? sample.memory.ramUsed} maximum={ramTotal ?? 0} />
      <Block label={t('resources.cpu')} value={percent(cpu)} samples={samples}
        read={(sample) => sample.stats?.cpuPercent ?? null} maximum={100} />
      <Block label={t('resources.gpu')} value={percent(gpu)} samples={samples}
        read={(sample) => sample.stats?.gpuUtilization ?? null} maximum={100} />
      <section className={styles.section}>
        <dl className={styles.pairs}>
          <dt>{t('resources.model')}</dt><dd>{gib(memory?.allocated ?? null)}</dd>
          <dt>{t('resources.cache')}</dt><dd>{gib(cacheUsed)}</dd>
          <dt>{t('resources.oom')}</dt><dd>{memory?.oom ?? none()}</dd>
          <dt>{t('resources.temperature')}</dt><dd>{temperature}</dd>
          <dt>{t('resources.fan')}</dt><dd>{percent(stats?.gpuFanPercent ?? null)}</dd>
          <dt>{t('resources.power')}</dt><dd>{stats?.gpuPowerWatts ?? none()} / {stats?.gpuPowerLimitWatts ?? none()} {t('resources.watts')}</dd>
        </dl>
      </section>
      <section className={styles.section}>
        <dl className={styles.pairs}>
          <dt>{server?.name ?? t('connection.none')}</dt><dd className="mono">{server?.url ?? ''}</dd>
          <dt>{t('resources.latency')}</dt><dd>{connection.latencyMs === null ? none() : t('resources.ms', { value: connection.latencyMs })}</dd>
          <dt>{t('resources.forgeVersion')}</dt><dd>{stats?.forgeVersion ?? none()}</dd>
          <dt>{t('resources.torchVersion')}</dt><dd>{stats?.torchVersion ?? none()}</dd>
          <dt>{t('resources.extensionVersion')}</dt><dd>{stats?.version ?? none()}</dd>
        </dl>
      </section>
      {resources.extension !== 'available' && <p className={styles.hint}>{t('resources.extensionHint')}</p>}
      <div className={styles.actions}>
        <Button onClick={onOpenServer}>{t('resources.switchServer')}</Button>
        <Button disabled={!server || running} onClick={() => void unload()}>{t('forge.unload')}</Button>
        <Button disabled={!server || !capabilities.canRestart} onClick={askRestart}>{t('forge.restart')}</Button>
      </div>
      {unloadState !== 'idle' && <p className={styles.status} role="status">{t(unloadState === 'done' ? 'resources.unloaded' : 'resources.unloadFailed')}</p>}
    </section>}
  </div>
}
