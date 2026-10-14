import { frameCaption, fullTime, shortTime } from './format'

const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo, d, h, mi, s).getTime()
const now = at(2026, 9, 14, 18, 30)

test('shortTime shows only the local clock for today', () => {
  expect(shortTime(at(2026, 9, 14, 14, 3), now)).toBe('14:03')
  expect(shortTime(at(2026, 9, 14, 0, 5), now)).toBe('00:05')
})

test('shortTime adds the day for another day, including the same day of another month or year', () => {
  expect(shortTime(at(2026, 9, 13, 14, 3), now)).toBe('Oct 13, 14:03')
  expect(shortTime(at(2026, 8, 14, 9, 0), now)).toBe('Sep 14, 09:00')
  expect(shortTime(at(2025, 9, 14, 9, 0), now)).toBe('Oct 14, 09:00')
})

test('fullTime has the date, the time and the seconds', () => {
  expect(fullTime(at(2026, 9, 14, 14, 3, 9))).toBe('Oct 14, 2026, 14:03:09')
})

test('the frame caption ends with the generation time', () => {
  const image = { id: 412, durationMs: 41_400, width: 832, height: 1216, createdAt: at(2026, 9, 14, 14, 3) }
  expect(frameCaption(image, now)).toBe('№ 0412 · 41 s · 832×1216 · 14:03')
  expect(frameCaption({ ...image, durationMs: null, createdAt: at(2026, 9, 13, 14, 3) }, now)).toBe('№ 0412 · 832×1216 · Oct 13, 14:03')
})
