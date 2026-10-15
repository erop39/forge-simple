import type { JobError } from '@shared/types'
import { baseName } from '../format'
import { t } from './t'

/** The tile text for a failed job: a message from the catalog and the server or system text, if any, verbatim. */
export function jobErrorText(e: JobError): { message: string; detail: string | null } {
  const detail = e.detail !== undefined && e.detail !== '' ? e.detail : null
  switch (e.code) {
    case 'missingParts':
      return { message: t('job.error.missingParts', { files: (e.missing ?? []).map(baseName).join(', ') }), detail }
    case 'forgeHttp':
      return { message: t('job.error.forgeHttp', { status: e.status ?? '?' }), detail }
    case 'forgeInvalid':
      return { message: t('job.error.forgeInvalid'), detail }
    case 'noImages':
      return { message: t('job.error.noImages'), detail }
    case 'storage':
      return { message: t('job.error.storage'), detail }
    case 'network':
      return { message: t('job.error.network'), detail }
    case 'stopped':
      return { message: t('job.error.stopped'), detail }
    case 'corruptJob':
      return { message: t('job.error.corruptJob'), detail }
    case 'sourceMissing':
      return { message: t('job.error.sourceMissing'), detail }
    case 'sourceLocked':
      return { message: t('job.error.sourceLocked'), detail }
    case 'sourceCorrupt':
      return { message: t('job.error.sourceCorrupt'), detail }
    case 'unexpected':
      return { message: t('job.error.unexpected'), detail }
  }
}
