import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '../locales/en'
import { TagEditor } from './TagEditor'
import { renderWithStore } from './test-store'

const input = () => screen.getByRole('combobox', { name: 'Tags' })

test('Enter and a comma add a tag, a duplicate in any case is ignored, Backspace removes the last, × removes one', async () => {
  const onChange = vi.fn()
  renderWithStore(<TagEditor tags={['sea']} label="Tags" onChange={onChange} />)
  await userEvent.type(input(), 'night{Enter}')
  expect(onChange).toHaveBeenLastCalledWith(['sea', 'night'])
  await userEvent.type(input(), 'SEA{Enter}')
  expect(onChange).toHaveBeenCalledTimes(1)
  await userEvent.type(input(), 'sun,')
  expect(onChange).toHaveBeenLastCalledWith(['sea', 'sun'])
  await userEvent.type(input(), '{Backspace}')
  expect(onChange).toHaveBeenLastCalledWith([])
  await userEvent.click(screen.getByRole('button', { name: 'Remove tag sea' }))
  expect(onChange).toHaveBeenLastCalledWith([])
})

test('suggestions add the chosen tag and skip tags already present', async () => {
  const onChange = vi.fn()
  const suggestTags = vi.fn(async () => ['sea', 'sunset'])
  renderWithStore(<TagEditor tags={['sea']} label="Tags" onChange={onChange} />, 'sdxl', { suggestTags })
  await userEvent.type(input(), 's')
  expect(screen.queryByRole('option', { name: 'sea' })).toBeNull()
  await userEvent.click(await screen.findByRole('option', { name: 'sunset' }))
  expect(onChange).toHaveBeenLastCalledWith(['sea', 'sunset'])
  expect(en['tags.add']).toBe('Add a tag')
})
