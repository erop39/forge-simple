import type { ConnectionState, ConnectionStatus } from '@shared/types'
import { t, type MessageKey } from '../i18n/t'
import styles from './ConnectionChip.module.css'

const LABELS: Record<ConnectionState, MessageKey> = {
  connected: 'connection.connected',
  slow: 'connection.slow',
  reconnecting: 'connection.reconnecting',
  offline: 'connection.offline',
}

type ConnectionChipProps = { status: ConnectionStatus; onClick: () => void; className?: string }

export function ConnectionChip({ status, onClick, className }: ConnectionChipProps) {
  const { state, latencyMs, attempts } = status
  const detail =
    state === 'reconnecting'
      ? attempts > 0
        ? t('connection.attempt', { n: attempts })
        : null
      : state === 'offline' || latencyMs === null
        ? null
        : t('connection.latency', { ms: Math.round(latencyMs) })
  return (
    <button type="button" className={[styles.chip, className].filter(Boolean).join(' ')} onClick={onClick}>
      <span className={`${styles.dot} ${styles[state]}`} data-dot aria-hidden="true" />
      <span>{t(LABELS[state])}</span>
      {detail !== null && <span className={`mono ${styles.detail}`}>{detail}</span>}
    </button>
  )
}
