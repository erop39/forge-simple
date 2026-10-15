import { useState } from 'react'
import type { ResourceSample } from '@shared/types'
import { LOCALE, t, type MessageKey } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
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

function Meter({ label, value, ratio, title }: { label: string; value: string; ratio: number | null; title?: string }) {
  const used = ratio === null ? null : Math.max(0, Math.min(1, ratio))
  return <span className={styles.meter} title={title}>
    <span className={styles.meterText}><span>{label}</span><span className="mono">{value}</span></span>
    <span className={styles.track}><span className={styles.fill} data-level={level(used, 1)} style={{ width: `${(used ?? 0) * 100}%` }} /></span>
  </span>
}

function Row({ label, value, samples, read, maximum }: {
  label: string; value: string; samples: ResourceSample[]; read(sample: ResourceSample): number | null; maximum: number
}) {
  const latestTime = samples.at(-1)?.time ?? 0
  const values = samples.filter((sample) => sample.time >= latestTime - 60_000)
    .map(read).filter((item): item is number => item !== null)
  const peak = values.length ? Math.max(...values) : null
  return <div className={styles.row}><span>{label}</span><strong className="mono">{value}</strong>
    <Sparkline samples={samples} value={read} maximum={maximum} />
    <span className={styles.peak}>{t('resources.peak')} {maximum === 100 ? percent(peak) : gib(peak)}</span>
  </div>
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
  const samples = resources.samples
  const latest = resources.failed || (connection.state !== 'connected' && connection.state !== 'slow')
    ? null : samples.at(-1) ?? null
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
  const metrics: { label: MessageKey; value: string; ratio: number | null; title?: string }[] = [
    { label: 'resources.vram', value: gib(vramUsed), ratio: vramRatio },
    { label: 'resources.ram', value: gib(ramUsed), ratio: ramRatio,
      title: stats ? undefined : t('resources.forgeProcessRam') },
    { label: 'resources.cpu', value: percent(cpu), ratio: cpu === null ? null : cpu / 100 },
    { label: 'resources.gpu', value: percent(gpu), ratio: gpu === null ? null : gpu / 100 },
  ]

  async function unload(): Promise<void> {
    setUnloadState('idle')
    try { await unloadModel(); setUnloadState('done') }
    catch { setUnloadState('failed') }
  }

  return <div className={styles.root}>
    <button className={styles.strip} type="button" aria-expanded={open} aria-label={t('resources.open')}
      onClick={() => setOpen((value) => !value)}>
      {metrics.map((metric) => <Meter key={metric.label} label={t(metric.label)} value={metric.value}
        ratio={metric.ratio} title={metric.title} />)}
    </button>
    {open && <section className={styles.panel} aria-label={t('resources.title')}>
      <div className={styles.head}><strong>{t('resources.title')}</strong><Button onClick={() => setOpen(false)}>{t('resources.close')}</Button></div>
      <Row label={t('resources.vram')} value={`${gib(vramUsed)} / ${gib(vramTotal)}`} samples={samples}
        read={(sample) => sample.stats?.gpuVramUsed ?? sample.memory.vramUsed} maximum={vramTotal ?? 0} />
      <div className={styles.vramTrack} role="img" aria-label={t('resources.vramBreakdown', { model: gib(memory?.allocated ?? null), cache: gib(cacheUsed) })}>
        <span className={styles.modelFill} style={{ width: `${modelShare}%` }} />
        <span className={styles.cacheFill} style={{ width: `${cacheShare}%` }} />
      </div>
      <Row label={t('resources.ram')} value={`${gib(ramUsed)} / ${gib(ramTotal)}`} samples={samples}
        read={(sample) => sample.stats?.ramUsed ?? sample.memory.ramUsed} maximum={ramTotal ?? 0} />
      <Row label={t('resources.cpu')} value={percent(cpu)} samples={samples}
        read={(sample) => sample.stats?.cpuPercent ?? null} maximum={100} />
      <Row label={t('resources.gpu')} value={percent(gpu)} samples={samples}
        read={(sample) => sample.stats?.gpuUtilization ?? null} maximum={100} />
      <div className={styles.detail}>
        <span>{t('resources.model')}: {gib(memory?.allocated ?? null)}</span>
        <span>{t('resources.cache')}: {gib(cacheUsed)}</span>
        <span>{t('resources.oom')}: {memory?.oom ?? none()}</span>
        <span>{t('resources.temperature')}: {stats?.gpuTemperature === null || stats?.gpuTemperature === undefined ? none() : t('resources.celsius', { value: whole.format(stats.gpuTemperature) })}</span>
        <span>{t('resources.fan')}: {percent(stats?.gpuFanPercent ?? null)}</span>
        <span>{t('resources.power')}: {stats?.gpuPowerWatts ?? none()} / {stats?.gpuPowerLimitWatts ?? none()} {t('resources.watts')}</span>
      </div>
      <div className={styles.server}>
        <span>{server?.name ?? t('connection.none')}</span><span className="mono">{server?.url ?? ''}</span>
        <span>{connection.latencyMs === null ? none() : t('resources.ms', { value: connection.latencyMs })}</span>
      </div>
      <div className={styles.detail}>
        <span>{t('resources.forgeVersion')}: {stats?.forgeVersion ?? none()}</span>
        <span>{t('resources.torchVersion')}: {stats?.torchVersion ?? none()}</span>
        <span>{t('resources.extensionVersion')}: {stats?.version ?? none()}</span>
      </div>
      {resources.extension !== 'available' && <p className={styles.hint}>{t('resources.extensionHint')}</p>}
      <div className={styles.actions}>
        <Button onClick={onOpenServer}>{t('resources.switchServer')}</Button>
        <Button disabled={!server || running} onClick={() => void unload()}>{t('forge.unload')}</Button>
        <Button disabled={!server || !capabilities.canRestart} onClick={askRestart}>{t('forge.restart')}</Button>
      </div>
      {unloadState !== 'idle' && <p role="status">{t(unloadState === 'done' ? 'resources.unloaded' : 'resources.unloadFailed')}</p>}
    </section>}
  </div>
}
