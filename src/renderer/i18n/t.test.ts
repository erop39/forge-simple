import { t } from './t'

test('substitutes named params', () => {
  expect(t('job.step', { current: 5, total: 8 })).toBe('step 5/8')
})

test('leaves an unknown placeholder visible', () => {
  expect(t('job.step', { current: 5 })).toBe('step 5/{total}')
})

test('returns the template unchanged when no params are given', () => {
  expect(t('job.step')).toBe('step {current}/{total}')
})
