import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '../locales/en'
import { TopBar } from './TopBar'
import { renderWithStore } from './test-store'

test('the focus button switches the gallery view and remembers the choice', async () => {
  localStorage.clear()
  const { store } = renderWithStore(<TopBar onOpenServer={() => undefined} />, 'sdxl', { focusMode: false })
  const button = screen.getByRole('button', { name: en['topbar.focus'] })
  expect(button.getAttribute('aria-pressed')).toBe('false')
  await userEvent.click(button)
  expect(store.getState().focusMode).toBe(true)
  expect(button.getAttribute('aria-pressed')).toBe('true')
  expect(localStorage.getItem('fnc.focusMode')).toBe('1')
  await userEvent.click(button)
  expect(store.getState().focusMode).toBe(false)
  expect(localStorage.getItem('fnc.focusMode')).toBe('0')
})
