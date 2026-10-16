import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '../locales/en'
import { ErrorBoundary } from './ErrorBoundary'

function Boom(): never {
  throw new Error('render failed')
}

test('a crash while rendering shows the message and Reload instead of a blank window', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const onReload = vi.fn()
  render(<ErrorBoundary onReload={onReload}><Boom /></ErrorBoundary>)
  expect(screen.getByRole('alert').textContent).toContain(en['crash.title'])
  await userEvent.click(screen.getByRole('button', { name: en['crash.reload'] }))
  expect(onReload).toHaveBeenCalledOnce()
  spy.mockRestore()
})

test('children render normally while nothing fails', () => {
  render(<ErrorBoundary><p>fine</p></ErrorBoundary>)
  expect(screen.getByText('fine')).toBeDefined()
})
