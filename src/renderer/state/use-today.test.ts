import { act, renderHook } from '@testing-library/react'
import { useToday } from './use-today'

afterEach(() => vi.useRealTimers())

test('renews itself just after midnight, not before', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 14, 23, 59, 0))
  const { result } = renderHook(() => useToday())
  const first = result.current
  act(() => { vi.advanceTimersByTime(30_000) })
  expect(result.current).toBe(first)
  act(() => { vi.advanceTimersByTime(31_000) })
  expect(new Date(result.current).getDate()).toBe(15)
})
