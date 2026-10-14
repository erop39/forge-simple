import type { OplogEntry } from '@shared/types'
import { en } from '../locales/en'
import { t, type MessageKey } from './t'

const isMessageKey = (key: string): key is MessageKey => Object.hasOwn(en, key)

/** One detail as text: lists joined with commas, null, missing values and objects as a dash. */
function detailText(value: unknown): string | number {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' || typeof v === 'number' ? v : t('logPanel.noValue'))).join(', ')
  return t('logPanel.noValue')
}

/** The catalog text of a log entry with its details filled in; an unknown key is shown as it is. */
export function logText(entry: OplogEntry): string {
  if (!isMessageKey(entry.messageKey)) return entry.messageKey
  const template: string = en[entry.messageKey]
  const params: Record<string, string | number> = {}
  for (const [, name] of template.matchAll(/\{(\w+)\}/g)) params[name!] = detailText(entry.details[name!])
  return t(entry.messageKey, params)
}
