import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '../locales/en'
import { SearchField } from './SearchField'
import { renderWithStore } from './test-store'

const field = () => screen.getByRole('combobox', { name: en['search.label'] })

test('/ outside text fields focuses the search; inside a text field it is typed as usual', async () => {
  renderWithStore(<><textarea aria-label="other" /><SearchField /></>)
  await userEvent.keyboard('/')
  expect(document.activeElement).toBe(field())
  field().blur()
  await userEvent.click(screen.getByLabelText('other'))
  await userEvent.keyboard('/')
  expect(document.activeElement).toBe(screen.getByLabelText('other'))
})

test('typing sets the text; a suggestion becomes a chip; Escape clears the text, then the chips, then leaves', async () => {
  const suggestTags = vi.fn(async () => ['night', 'nightmare'])
  const { store } = renderWithStore(<SearchField />, 'sdxl', { suggestTags })
  await userEvent.type(field(), 'nig')
  expect(store.getState().query.text).toBe('nig')
  const option = await screen.findByRole('option', { name: 'night' })
  await userEvent.click(option)
  expect(store.getState().query).toEqual({ text: '', tags: ['night'] })
  expect(screen.getByRole('button', { name: 'Remove tag night from the search' })).toBeDefined()
  await userEvent.type(field(), 'fox')
  await userEvent.keyboard('{Escape}')
  expect(store.getState().query).toEqual({ text: '', tags: ['night'] })
  await userEvent.keyboard('{Escape}')
  expect(store.getState().query).toEqual({ text: '', tags: [] })
  await userEvent.keyboard('{Escape}')
  expect(document.activeElement).not.toBe(field())
})

test('arrow keys pick a suggestion with Enter; Backspace in the empty field removes the last chip', async () => {
  const suggestTags = vi.fn(async () => ['alpha', 'beta'])
  const { store } = renderWithStore(<SearchField />, 'sdxl', { suggestTags })
  await userEvent.type(field(), 'a')
  await screen.findByRole('option', { name: 'beta' })
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}')
  expect(store.getState().query.tags).toEqual(['beta'])
  act(() => store.getState().setQuery({ tags: ['beta', 'sea'] }))
  await userEvent.click(field())
  await userEvent.keyboard('{Backspace}')
  expect(store.getState().query.tags).toEqual(['beta'])
})
