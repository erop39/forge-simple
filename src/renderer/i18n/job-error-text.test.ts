import type { JobErrorCode } from '@shared/types'
import { en } from '../locales/en'
import { jobErrorText } from './job-error-text'

const CODES: JobErrorCode[] = [
  'missingParts', 'forgeHttp', 'forgeInvalid', 'noImages', 'storage', 'network', 'stopped', 'corruptJob', 'unexpected',
]

test('every code maps to its catalog message', () => {
  for (const code of CODES) {
    const { message } = jobErrorText({ code, status: 500, missing: ['x.safetensors'] })
    expect(message).not.toContain('job.error')
    expect(message.length).toBeGreaterThan(0)
  }
  expect(jobErrorText({ code: 'noImages' }).message).toBe(en['job.error.noImages'])
})

test('missingParts lists the base names of the missing files', () => {
  const { message } = jobErrorText({
    code: 'missingParts',
    missing: ['C:\\models\\VAE\\ae.safetensors', 'text_encoder/clip.safetensors'],
  })
  expect(message).toBe('Missing on the server: ae.safetensors, clip.safetensors')
})

test('forgeHttp carries the status', () => {
  expect(jobErrorText({ code: 'forgeHttp', status: 502 }).message).toBe('Forge returned an error (502).')
})

test('detail is passed through verbatim, and is null when absent or empty', () => {
  expect(jobErrorText({ code: 'unexpected', detail: 'CUDA out of memory' }).detail).toBe('CUDA out of memory')
  expect(jobErrorText({ code: 'unexpected' }).detail).toBeNull()
  expect(jobErrorText({ code: 'unexpected', detail: '' }).detail).toBeNull()
})
