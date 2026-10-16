import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react'
import type { Job, JobProgress } from '@shared/types'
import { shortTime } from '../format'
import { jobErrorText } from '../i18n/job-error-text'
import { t, type MessageKey } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Tooltip } from './ui/Tooltip'
import styles from './JobTile.module.css'

/** waitingFor: the name of the (inactive) server a queued job waits for; null when it is in the active queue. */
/** now: a moment of the current day, for the time a failed job ended. */
/** tabStop: the gallery's roving tab stop; false takes the tile and its buttons out of the tab order. */
type JobTileProps = {
  job: Job; progress: JobProgress | null; queuePosition: number | null; waitingFor?: string | null; now?: number
  tabStop?: boolean
}

const STAGE_KEYS: Record<JobProgress['stage'], MessageKey> = {
  sampling: 'job.stage.sampling',
  hires: 'job.stage.hires',
  upscaling: 'job.stage.upscaling',
}

const queuedText = (queuePosition: number | null, waitingFor: string | null): string =>
  waitingFor === null ? t('job.queued', { n: queuePosition ?? 1 }) : t('job.waitingFor', { name: waitingFor })

type BodyProps = { job: Job; tabIndex: number }

function QueuedBody({ job, queuePosition, waitingFor, tabIndex }: BodyProps & { queuePosition: number | null; waitingFor: string | null }) {
  const cancelJob = useAppStore((s) => s.cancelJob)
  const text = queuedText(queuePosition, waitingFor)
  return (
    <>
      {waitingFor === null ? (
        <span className={`mono ${styles.queued}`}>{text}</span>
      ) : (
        <span className={`${styles.queued} ${styles.waitingFor}`} title={text}>
          {text}
        </span>
      )}
      <Button className={styles.corner} tabIndex={tabIndex} onClick={() => void cancelJob(job.id)}>
        {t('job.cancel')}
      </Button>
    </>
  )
}

function RunningBody({ job, progress, tabIndex }: BodyProps & { progress: JobProgress | null }) {
  const cancelJob = useAppStore((s) => s.cancelJob)
  const total = progress?.totalSteps ?? job.params.steps
  const step = progress?.step ?? 0
  const ratio = total > 0 ? Math.min(1, step / total) : 0
  const stage = t(STAGE_KEYS[progress?.stage ?? 'sampling'])
  const line = [
    stage,
    t('job.step', { current: step, total }),
    progress?.stepsPerSec != null ? t('job.speed', { v: progress.stepsPerSec.toFixed(1) }) : null,
    progress ? t('job.elapsed', { s: Math.floor(progress.elapsedMs / 1000) }) : null,
    progress?.stalledMs ? t('job.noProgress', { s: Math.floor(progress.stalledMs / 1000) }) : null,
  ]
    .filter((part) => part !== null)
    .join(' · ')
  return (
    <>
      {progress?.preview && <img src={progress.preview} alt="" className={styles.preview} />}
      <Button className={styles.corner} tabIndex={tabIndex} onClick={() => void cancelJob(job.id)}>
        {t('job.cancel')}
      </Button>
      <div className={styles.footer}>
        <span className={`mono ${styles.line}`} title={line}>
          {line}
        </span>
        <div
          role="progressbar"
          aria-label={stage}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={step}
          className={styles.track}
        >
          <div className={styles.fill} style={{ transform: `scaleX(${ratio})` }} />
        </div>
      </div>
    </>
  )
}

function FailedBody({ job, now, tabIndex }: BodyProps & { now: number | undefined }) {
  const retryJob = useAppStore((s) => s.retryJob)
  const dismissJob = useAppStore((s) => s.dismissJob)
  const askRestart = useAppStore((s) => s.askRestart)
  // A Forge 500 often means its model state broke; a restart is the cure when Forge allows it.
  const offerRestart = useAppStore((s) => s.capabilities.canRestart)
    && job.error?.code === 'forgeHttp' && job.error.status === 500
  const { message, detail } = jobErrorText(job.error ?? { code: 'unexpected' })
  return (
    <div className={styles.failed}>
      <h3 className={styles.heading}>
        <WarningCircle size={20} aria-hidden="true" />
        {t(job.status === 'interrupted' ? 'job.interrupted' : 'job.failed')}
        {job.finishedAt !== null && <span className={`mono ${styles.when}`}>{shortTime(job.finishedAt, now)}</span>}
      </h3>
      <p className={styles.message}>{message}</p>
      {detail !== null && (
        <Tooltip text={detail}>
          <span tabIndex={tabIndex} className={`mono ${styles.detail}`}>
            {detail}
          </span>
        </Tooltip>
      )}
      <div className={styles.actions}>
        <Button tabIndex={tabIndex} onClick={() => void retryJob(job.id)}>{t('job.retry')}</Button>
        {offerRestart && (
          <IconButton
            label={t('job.restartForge')}
            icon={<ArrowClockwise size={16} />}
            tabIndex={tabIndex}
            onClick={askRestart}
          />
        )}
        <Button tabIndex={tabIndex} onClick={() => dismissJob(job.id)}>{t('job.dismiss')}</Button>
      </div>
    </div>
  )
}

/**
 * A job that has not produced an image yet: waiting, running, failed or interrupted. The tile itself is
 * its focus target (`data-primary`) for the gallery's keyboard navigation; its buttons follow it.
 */
export function JobTile({ job, progress, queuePosition, waitingFor = null, now, tabStop = true }: JobTileProps) {
  const tabIndex = tabStop ? 0 : -1
  const failed = job.status === 'failed' || job.status === 'interrupted'
  const stateClass = failed
    ? job.status === 'interrupted'
      ? styles.interrupted
      : styles.failedTile
    : job.status === 'queued'
      ? styles.waiting
      : styles.running
  const label = failed
    ? t(job.status === 'interrupted' ? 'job.interrupted' : 'job.failed')
    : job.status === 'queued'
      ? queuedText(queuePosition, waitingFor)
      : t(STAGE_KEYS[progress?.stage ?? 'sampling'])
  return (
    <div
      role="group"
      aria-label={label}
      data-status={job.status}
      data-primary
      tabIndex={tabIndex}
      className={`${styles.tile} ${stateClass}`}
      style={{ aspectRatio: `${job.params.width} / ${job.params.height}` }}
    >
      {failed ? (
        <FailedBody job={job} now={now} tabIndex={tabIndex} />
      ) : job.status === 'queued' ? (
        <QueuedBody job={job} queuePosition={queuePosition} waitingFor={waitingFor} tabIndex={tabIndex} />
      ) : (
        <RunningBody job={job} progress={progress} tabIndex={tabIndex} />
      )}
    </div>
  )
}
