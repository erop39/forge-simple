import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { NumberField } from './NumberField'
import { Slider } from './Slider'
import { wheelValue } from './use-wheel-step'

test('wheelValue steps, clamps and keeps to multipleOf', () => {
  expect(wheelValue(7, 1, { min: 1, max: 30, step: 0.5 })).toBe(7.5)
  expect(wheelValue(7.1, 3, { min: 1, max: 30, step: 0.1 })).toBe(7.4)
  expect(wheelValue(29, 10, { min: 1, max: 30, step: 1 })).toBe(30)
  expect(wheelValue(2, -10, { min: 1, max: 30, step: 1 })).toBe(1)
  expect(wheelValue(1024, 1, { min: 64, max: 4096, step: 8, multipleOf: 8 })).toBe(1032)
  expect(wheelValue(1020, 1, { min: 64, max: 4096, step: 8, multipleOf: 8 })).toBe(1032)
  expect(wheelValue(4090, 10, { min: 60, max: 4090, step: 8, multipleOf: 8 })).toBe(4088)
  expect(wheelValue(70, -10, { min: 60, max: 4090, step: 8, multipleOf: 8 })).toBe(64)
})

type Props = { initial: number; min: number; max: number; step?: number; multipleOf?: number; onCommit: (n: number) => void }

function Field({ initial, onCommit, ...rest }: Props) {
  const [value, setValue] = useState(initial)
  return (
    <NumberField inline label="Width" value={value} {...rest} onCommit={(n) => { setValue(n); onCommit(n) }} />
  )
}

function Steps({ initial, onCommit, ...rest }: Props) {
  const [value, setValue] = useState(initial)
  return <Slider inline label="Steps" value={value} step={1} {...rest} onCommit={(n) => { setValue(n); onCommit(n) }} />
}

/** Fires a wheel event and reports whether the default (page scroll) was prevented. */
const wheel = (el: Element, init: WheelEventInit): boolean => !fireEvent.wheel(el, init)

test('over a number field: up adds a step, down removes one, Shift moves ten, and the page does not scroll', () => {
  const onCommit = vi.fn()
  render(<Field initial={1024} min={64} max={4096} step={8} multipleOf={8} onCommit={onCommit} />)
  const field = screen.getByRole('spinbutton', { name: 'Width' })
  expect(wheel(field, { deltaY: -100 })).toBe(true)
  expect(onCommit).toHaveBeenLastCalledWith(1032)
  wheel(field, { deltaY: 100 })
  expect(onCommit).toHaveBeenLastCalledWith(1024)
  wheel(field, { deltaY: -100, shiftKey: true })
  expect(onCommit).toHaveBeenLastCalledWith(1104)
  // Chromium sends Shift+wheel as horizontal scrolling.
  wheel(field, { deltaY: 0, deltaX: 100, shiftKey: true })
  expect(onCommit).toHaveBeenLastCalledWith(1024)
  expect((field as HTMLInputElement).value).toBe('1024')
})

test('the label of an inline field counts as over the field', () => {
  const onCommit = vi.fn()
  render(<Field initial={2} min={1} max={8} onCommit={onCommit} />)
  wheel(screen.getByText('Width'), { deltaY: -100 })
  expect(onCommit).toHaveBeenCalledWith(3)
})

test('at a bound nothing is committed, but the page still does not scroll', () => {
  const onCommit = vi.fn()
  render(<Field initial={8} min={1} max={8} onCommit={onCommit} />)
  expect(wheel(screen.getByRole('spinbutton'), { deltaY: -100 })).toBe(true)
  expect(onCommit).not.toHaveBeenCalled()
})

test('small trackpad deltas add up to one step per 100 px; a change of direction starts over', () => {
  const onCommit = vi.fn()
  render(<Steps initial={20} min={1} max={150} onCommit={onCommit} />)
  const slider = screen.getByText('Steps')
  for (let i = 0; i < 4; i++) wheel(slider, { deltaY: -20 })
  expect(onCommit).not.toHaveBeenCalled()
  wheel(slider, { deltaY: -20 })
  expect(onCommit).toHaveBeenCalledTimes(1)
  expect(onCommit).toHaveBeenLastCalledWith(21)
  wheel(slider, { deltaY: -60 })
  wheel(slider, { deltaY: 60 })
  expect(onCommit).toHaveBeenCalledTimes(1)
  wheel(slider, { deltaY: 3, deltaMode: 1 })
  expect(onCommit).toHaveBeenLastCalledWith(20)
})

test('a sideways wheel without Shift is left to the page', () => {
  const onCommit = vi.fn()
  render(<Steps initial={20} min={1} max={150} onCommit={onCommit} />)
  expect(wheel(screen.getByText('Steps'), { deltaY: 0, deltaX: 100 })).toBe(false)
  expect(onCommit).not.toHaveBeenCalled()
})
