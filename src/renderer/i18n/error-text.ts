import { extractErrorKey, type IpcErrorKey } from '@shared/ipc'
import { t } from './t'

/** The catalog key behind a caught error or a raw key string; anything unrecognised is 'error.unexpected'. */
export function errorKeyOf(e: unknown): IpcErrorKey {
  if (e instanceof Error) return extractErrorKey(e.message)
  if (typeof e === 'string') return extractErrorKey(e)
  return 'error.unexpected'
}

/** User-facing text for a caught error. The error's own message is never shown. */
export function errorText(e: unknown): string {
  return t(errorKeyOf(e))
}
