import { Check, Warning } from '@phosphor-icons/react'
import { baseName } from '../format'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Tooltip } from './ui/Tooltip'
import styles from './ModelCard.module.css'

/** The checkpoint and the modules it needs, each with whether Forge has the file. */
export function ModelCard() {
  const parts = useAppStore((s) => s.parts)
  if (parts.length === 0) return null
  return (
    <ul className={styles.card}>
      {parts.map((part) => (
        <li key={`${part.role}:${part.value}`} className={styles.row}>
          <span className={styles.role}>{part.role === 'model' ? t('params.model') : t('params.module')}</span>
          <Tooltip text={part.value}>
            <span tabIndex={0} className={`mono ${styles.name}`}>
              {baseName(part.value)}
            </span>
          </Tooltip>
          {part.found ? (
            <span className={styles.ok}>
              <Check size={16} aria-hidden="true" />
              <span className="sr-only">{t('params.found')}</span>
            </span>
          ) : (
            <span className={styles.missing}>
              <Warning size={16} aria-hidden="true" />
              {t('params.notFound')}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
