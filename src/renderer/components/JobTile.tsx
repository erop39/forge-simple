import { WarningCircle } from '@phosphor-icons/react'
import type { Job, JobProgress } from '@shared/types'
import { jobErrorText } from '../i18n/job-error-text'
import { t, type MessageKey } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { Tooltip } from './ui/Tooltip'
import styles from './JobTile.module.css'

/** waitingFor: the name of the (inactive) server a queued job waits for; null when it is in the active queue. */
type JobTileProps = { job: Job; progress: JobProgress | null; queuePosition: number | null; waitingFor?: string | null }

const STAGE_KEYS: Record<JobProgress['stage'], MessageKey> = {
  sampling: 'job.stage.sampling',
  hires: 'job.stage.hires',
  upscaling: 'job.stage.upscaling',
}

function QueuedBody({ job, queuePosition, waitingFor }: { job: Job; queuePosition: number | null; waitingFor: string | null }) {
  const cancelJob = useAppStore((s) => s.cancelJob)
  const waiting = waitingFor === null ? null : t('job.waitingFor', { name: waitingFor })
  return (
    <>
      {waiting === null ? (
        <span className={`mono ${styles.queued}`}>{t('job.queued', { n: queuePosition ?? 1 })}</span>
      ) : (
        <span className={`${styles.queued} ${styles.waitingFor}`} title={waiting}>
          {waiting}
        </span>
      )}
      <Button className={styles.corner} onClick={() => void cancelJob(job.id)}>
        {t('job.cancel')}
      </Button>
    </>
  )
}

function RunningBody({ job, progress }: { job: Job; progress: JobProgress | null }) {
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
  ]
    .filter((part) => part !== null)
    .join(' · ')
  return (
    <>
      {progress?.preview && <img src={progress.preview} alt="" className={styles.preview} />}
      <Button className={styles.corner} onClick={() => void cancelJob(job.id)}>
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

function FailedBody({ job }: { job: Job }) {
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
      </h3>
      <p className={styles.message}>{message}</p>
      {detail !== null && (
        <Tooltip text={detail}>
          <span tabIndex={0} className={`mono ${styles.detail}`}>
            {detail}
          </span>
        </Tooltip>
      )}
      <div className={styles.actions}>
        <Button onClick={() => void retryJob(job.id)}>{t('job.retry')}</Button>
        {offerRestart && <Button onClick={askRestart}>{t('job.restartForge')}</Button>}
        <Button onClick={() => dismissJob(job.id)}>{t('job.dismiss')}</Button>
      </div>
    </div>
  )
}

/** A job that has not produced an image yet: waiting, running, failed or interrupted. */
export function JobTile({ job, progress, queuePosition, waitingFor = null }: JobTileProps) {
  const failed = job.status === 'failed' || job.status === 'interrupted'
  const stateClass = failed
    ? job.status === 'interrupted'
      ? styles.interrupted
      : styles.failedTile
    : job.status === 'queued'
      ? styles.waiting
      : styles.running
  return (
    <div
      data-status={job.status}
      className={`${styles.tile} ${stateClass}`}
      style={{ aspectRatio: `${job.params.width} / ${job.params.height}` }}
    >
      {failed ? (
        <FailedBody job={job} />
      ) : job.status === 'queued' ? (
        <QueuedBody job={job} queuePosition={queuePosition} waitingFor={waitingFor} />
      ) : (
        <RunningBody job={job} progress={progress} />
      )}
    </div>
  )
}
