import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { ParamRow } from './ParamRow'
import { Select } from './Select'
import { Tooltip } from './Tooltip'

const options = [
  { value: 'Euler', label: 'Euler' },
  { value: 'DPM', label: 'DPM' },
]

test('IconButton exposes its label to assistive tech', () => {
  render(<IconButton label="Settings" icon={<span />} />)
  expect(screen.getByRole('button', { name: 'Settings' })).toBeDefined()
})

test('Select reports the chosen value', async () => {
  const onChange = vi.fn()
  render(<Select label="Sampler" value="Euler" options={options} onChange={onChange} />)
  await userEvent.click(screen.getByRole('button', { name: /Sampler/ }))
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'DPM' }))
  expect(onChange).toHaveBeenCalledWith('DPM')
})

test('Select marks the current value as checked', async () => {
  render(<Select label="Sampler" value="Euler" options={options} onChange={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: /Sampler/ }))
  expect(screen.getByRole('menuitemradio', { name: 'Euler' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('menuitemradio', { name: 'DPM' }).getAttribute('aria-checked')).toBe('false')
})

test('Button fires onClick and renders icon and label', async () => {
  const onClick = vi.fn()
  render(
    <Button variant="primary" icon={<i data-testid="icon" />} onClick={onClick}>
      {'Generate'}
    </Button>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('icon')).toBeDefined()
})

test('disabled Button does not fire onClick', async () => {
  const onClick = vi.fn()
  render(
    <Button disabled onClick={onClick}>
      {'Generate'}
    </Button>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Generate' }))
  expect(onClick).not.toHaveBeenCalled()
})

test('ParamRow shows its label and value', () => {
  render(
    <ParamRow label="Steps">
      <span>{'20'}</span>
    </ParamRow>,
  )
  expect(screen.getByText('Steps')).toBeDefined()
  expect(screen.getByText('20')).toBeDefined()
})

test('Tooltip shows its text on keyboard focus', async () => {
  render(
    <Tooltip text="Hint">
      <button>{'Target'}</button>
    </Tooltip>,
  )
  await userEvent.tab()
  expect(await screen.findByRole('tooltip')).toBeDefined()
})

const grouped = [
  { value: 'a', label: 'alpha', group: 'First' },
  { value: 'b', label: 'beta', group: 'First' },
  { value: 'c', label: 'gamma', group: 'Second' },
]

test('Select shows grouped options under labelled groups, in the given order', async () => {
  render(<Select label="Model" value="c" options={grouped} onChange={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: /Model/ }))
  const first = screen.getByRole('group', { name: 'First' })
  const second = screen.getByRole('group', { name: 'Second' })
  expect(within(first).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['alpha', 'beta'])
  expect(within(second).getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['gamma'])
})

test('Select without groups renders no group labels', async () => {
  render(<Select label="Sampler" value="Euler" options={options} onChange={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: /Sampler/ }))
  expect(screen.queryAllByRole('group').filter((g) => g.getAttribute('aria-labelledby'))).toEqual([])
})

test('Select opens a scrollable menu with the checked option focused', async () => {
  render(<Select label="Model" value="b" options={grouped} onChange={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: /Model/ }))
  const menu = screen.getByRole('menu')
  expect(menu.className).toMatch(/content/)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'beta' })))
  await userEvent.keyboard('{ArrowDown}')
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'gamma' }))
})

test('a growing Select carries the full value as its tooltip', () => {
  render(<Select grow label="Model" value="c" options={grouped} onChange={() => {}} />)
  expect(screen.getByRole('button', { name: /Model/ }).getAttribute('title')).toBe('gamma')
})
