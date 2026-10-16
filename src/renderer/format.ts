import type { ImageRecord } from '@shared/types'
import { LOCALE, t } from './i18n/t'

/** The last path segment of a Windows or POSIX path. */
/** A size in bytes as KB, MB or GB (one decimal from MB up). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export const baseName = (value: string): string => value.split(/[\\/]/).pop() ?? value

const clock = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dayAndClock = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
const fullDateTime = new Intl.DateTimeFormat(LOCALE, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** Local time of a moment: only the clock today, the day and clock on another day. */
export function shortTime(ms: number, now: number = Date.now()): string {
  const at = new Date(ms)
  return sameDay(at, new Date(now)) ? clock.format(at) : dayAndClock.format(at)
}

/** Local date and time with seconds, for the image viewer. */
export const fullTime = (ms: number): string => fullDateTime.format(ms)

/** The frame marking of an image: № 0412 · 41 s · 832×1216 · 14:03; the seconds are left out when unknown. */
export function frameCaption(
  image: Pick<ImageRecord, 'id' | 'durationMs' | 'width' | 'height' | 'createdAt'>,
  now: number = Date.now(),
): string {
  const n = String(image.id).padStart(4, '0')
  const size = { n, w: image.width, h: image.height, time: shortTime(image.createdAt, now) }
  return image.durationMs === null
    ? t('image.frameNoTime', size)
    : t('image.frame', { ...size, s: Math.round(image.durationMs / 1000) })
}
