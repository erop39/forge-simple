import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Slider } from './Slider'

type HarnessProps = { initial: number; min: number; max: number; step: number; onCommit?: (value: number) => void }

/** Keeps the value in state, as the store does for real params. */
function Harness({ initial, min, max, step, onCommit }: HarnessProps) {
  const [value, setValue] = useState(initial)
  return (
    <Slider
      label="CFG"
      value={value}
      min={min}
      max={max}
      step={step}
      onCommit={(next) => {
        setValue(next)
        onCommit?.(next)
      }}
    />
  )
}

const thumb = () => screen.getByRole('slider', { name: 'CFG' })

test('inline shows its label, its value and the bounds for assistive tech', () => {
  render(<Slider inline label="CFG" value={7.5} min={1} max={30} step={0.5} onCommit={() => {}} />)
  expect(screen.getByText('CFG')).toBeDefined()
  expect(screen.getByText('7.5')).toBeDefined()
  expect(thumb().getAttribute('aria-valuenow')).toBe('7.5')
  expect(thumb().getAttribute('aria-valuemin')).toBe('1')
  expect(thumb().getAttribute('aria-valuemax')).toBe('30')
})

test('arrow keys move by one step and commit the new value', async () => {
  const onCommit = vi.fn()
  render(<Harness initial={7} min={1} max={30} step={0.5} onCommit={onCommit} />)
  thumb().focus()
  await userEvent.keyboard('{ArrowRight}')
  expect(onCommit).toHaveBeenLastCalledWith(7.5)
  await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
  expect(onCommit).toHaveBeenLastCalledWith(6.5)
  expect(screen.getByText('6.5')).toBeDefined()
})

test('the value stays within its bounds', async () => {
  const onCommit = vi.fn()
  render(<Harness initial={30} min={1} max={30} step={0.5} onCommit={onCommit} />)
  thumb().focus()
  await userEvent.keyboard('{ArrowRight}')
  expect(onCommit).not.toHaveBeenCalled()
  expect(thumb().getAttribute('aria-valuenow')).toBe('30')
})

test('Home and End jump to the bounds', async () => {
  const onCommit = vi.fn()
  render(<Harness initial={20} min={1} max={150} step={1} onCommit={onCommit} />)
  thumb().focus()
  await userEvent.keyboard('{Home}')
  expect(onCommit).toHaveBeenLastCalledWith(1)
  await userEvent.keyboard('{End}')
  expect(onCommit).toHaveBeenLastCalledWith(150)
})

test('without inline the label is not shown but still names the slider', () => {
  render(<Slider label="CFG" value={7} min={1} max={30} step={0.5} onCommit={() => {}} />)
  expect(thumb()).toBeDefined()
  expect(screen.queryByText('CFG')).toBeNull()
  expect(screen.getByText('7')).toBeDefined()
})
