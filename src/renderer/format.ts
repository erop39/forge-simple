import type { ImageRecord } from '@shared/types'
import { t } from './i18n/t'

/** The last path segment of a Windows or POSIX path. */
export const baseName = (value: string): string => value.split(/[\\/]/).pop() ?? value

/** The frame marking of an image: № 0412 · 41 s · 832×1216; the seconds are left out when unknown. */
export function frameCaption(image: Pick<ImageRecord, 'id' | 'durationMs' | 'width' | 'height'>): string {
  const n = String(image.id).padStart(4, '0')
  const size = { n, w: image.width, h: image.height }
  return image.durationMs === null
    ? t('image.frameNoTime', size)
    : t('image.frame', { ...size, s: Math.round(image.durationMs / 1000) })
}
