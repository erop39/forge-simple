import type { ConnectionState, ConnectionStatus } from '@shared/types'
import { t, type MessageKey } from '../i18n/t'
import styles from './ConnectionChip.module.css'

const LABELS: Record<ConnectionState, MessageKey> = {
  connected: 'connection.connected',
  slow: 'connection.slow',
  reconnecting: 'connection.reconnecting',
  offline: 'connection.offline',
}

/**
 * A null status means no server is configured: a neutral chip that still opens the dialog.
 * serverName is the active server's name, shown before the status and cut with an ellipsis.
 */
type ConnectionChipProps = {
  status: ConnectionStatus | null
  serverName?: string | null
  onClick: () => void
  className?: string
}

export function ConnectionChip({ status, serverName = null, onClick, className }: ConnectionChipProps) {
  if (status === null) {
    return (
      <button type="button" className={[styles.chip, className].filter(Boolean).join(' ')} onClick={onClick}>
        <span className={styles.dot} data-dot aria-hidden="true" />
        <span>{t('connection.none')}</span>
      </button>
    )
  }
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
      {serverName && (
        <span className={styles.name} title={serverName}>
          {serverName}
        </span>
      )}
      <span className={serverName ? styles.state : undefined}>{t(LABELS[state])}</span>
      {detail !== null && <span className={`mono ${styles.detail}`}>{detail}</span>}
    </button>
  )
}
