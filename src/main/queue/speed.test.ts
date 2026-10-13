import { stepsPerSec } from './speed'

test('two samples one second and four steps apart → 4', () => {
  expect(stepsPerSec([{ t: 1000, step: 2 }, { t: 2000, step: 6 }])).toBe(4)
})

test('uses first and last sample', () => {
  const samples = [
    { t: 0, step: 0 },
    { t: 1000, step: 10 }, // a burst in the middle must not matter
    { t: 4000, step: 12 },
  ]
  expect(stepsPerSec(samples)).toBe(3)
})

test('null with a single sample or no step change', () => {
  expect(stepsPerSec([])).toBeNull()
  expect(stepsPerSec([{ t: 0, step: 3 }])).toBeNull()
  expect(stepsPerSec([{ t: 0, step: 3 }, { t: 1000, step: 3 }])).toBeNull()
  expect(stepsPerSec([{ t: 0, step: 3 }, { t: 0, step: 5 }])).toBeNull()
})
