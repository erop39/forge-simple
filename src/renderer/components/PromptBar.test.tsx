import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '../locales/en'
import { PromptBar } from './PromptBar'
import { renderWithStore } from './test-store'

const promptField = () => screen.getByRole('textbox', { name: en['prompt.placeholder'] })
const generateButton = () => screen.getByRole('button', { name: en['prompt.generate'] })

afterEach(() => localStorage.clear())

test('Ctrl+Enter in the prompt field calls generate', async () => {
  const generate = vi.fn(async () => {})
  renderWithStore(<PromptBar />, 'sdxl', { generate })
  await userEvent.type(promptField(), 'a fox')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  expect(generate).toHaveBeenCalledTimes(1)
  expect((promptField() as HTMLTextAreaElement).value).toBe('a fox')
})

test('plain Enter inserts a newline and does not generate', async () => {
  const generate = vi.fn(async () => {})
  renderWithStore(<PromptBar />, 'sdxl', { generate })
  await userEvent.type(promptField(), 'a{Enter}b')
  expect(generate).not.toHaveBeenCalled()
  expect((promptField() as HTMLTextAreaElement).value).toBe('a\nb')
})

test('the Generate button is disabled-looking and inert while the prompt is blank', async () => {
  const generate = vi.fn(async () => {})
  renderWithStore(<PromptBar />, 'sdxl', { generate })
  const button = generateButton() as HTMLButtonElement
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.disabled).toBe(false)
  await userEvent.click(button)
  expect(generate).not.toHaveBeenCalled()
  await userEvent.type(promptField(), 'x')
  expect(button.getAttribute('aria-disabled')).toBe('false')
  await userEvent.click(button)
  expect(generate).toHaveBeenCalledTimes(1)
})

test('ArrowUp in an empty field restores the last submitted prompt', async () => {
  renderWithStore(<PromptBar />, 'sdxl', { generate: vi.fn(async () => {}) })
  await userEvent.type(promptField(), 'a fox')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await userEvent.clear(promptField())
  await userEvent.keyboard('{ArrowUp}')
  expect((promptField() as HTMLTextAreaElement).value).toBe('a fox')
  expect(localStorage.getItem('fnc.lastPrompt')).toBe('a fox')
})

test('choosing ratio 3:4 sets width 896 and height 1152 for an sdxl checkpoint', async () => {
  const { store } = renderWithStore(<PromptBar />, 'sdxl')
  store.getState().setParams({ width: 1024, height: 1024 })
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(en['prompt.ratio']) }))
  await userEvent.click(screen.getByRole('menuitemradio', { name: '3:4' }))
  expect(store.getState().params).toMatchObject({ width: 896, height: 1152 })
})

test('a matching size reads its ratio and an unmatched one reads Custom', async () => {
  const { store } = renderWithStore(<PromptBar />, 'sdxl')
  expect(screen.getByRole('button', { name: new RegExp(en['prompt.ratio']) }).textContent).toContain('3:4')
  store.getState().setParams({ width: 520, height: 520 })
  expect(await screen.findByText(en['prompt.ratioCustom'])).toBeDefined()
})

test('the Negative toggle reveals the negative field; it is absent for a krea2 checkpoint', async () => {
  const { unmount } = renderWithStore(<PromptBar />, 'sdxl')
  expect(screen.queryByRole('textbox', { name: en['prompt.negative'] })).toBeNull()
  const toggle = screen.getByRole('button', { name: en['prompt.negative'] })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await userEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('textbox', { name: en['prompt.negative'] })).toBeDefined()
  unmount()

  renderWithStore(<PromptBar />, 'krea2')
  expect(screen.queryByRole('button', { name: en['prompt.negative'] })).toBeNull()
})

test('Images accepts 1 to 8', async () => {
  const { store } = renderWithStore(<PromptBar />, 'sdxl')
  const images = screen.getByRole('spinbutton', { name: en['prompt.images'] })
  await userEvent.clear(images)
  await userEvent.type(images, '5')
  expect(store.getState().params?.count).toBe(5)
  await userEvent.clear(images)
  await userEvent.type(images, '9')
  expect(store.getState().params?.count).toBe(5)
  await userEvent.tab()
  expect((images as HTMLInputElement).value).toBe('5')
  await userEvent.clear(images)
  await userEvent.type(images, '0')
  expect(store.getState().params?.count).toBe(5)
})

test('Steps steps by one with the arrow keys within its bounds', async () => {
  const { store } = renderWithStore(<PromptBar />, 'sdxl')
  const steps = screen.getByRole('spinbutton', { name: en['prompt.steps'] })
  store.getState().setParams({ steps: 200 })
  await userEvent.click(steps)
  await userEvent.keyboard('{ArrowUp}')
  expect(store.getState().params?.steps).toBe(200)
  await userEvent.keyboard('{ArrowDown}')
  expect(store.getState().params?.steps).toBe(199)
})

test('All parameters toggles the panel and reflects it in aria-expanded', async () => {
  const { store } = renderWithStore(<PromptBar />)
  const button = screen.getByRole('button', { name: en['prompt.allParams'] })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  await userEvent.click(button)
  expect(store.getState().panelOpen).toBe(true)
  expect(button.getAttribute('aria-expanded')).toBe('true')
})

test('the bar is not rendered without parameters', () => {
  const { container } = renderWithStore(<PromptBar />, 'sdxl', { params: null })
  expect(container.textContent).toBe('')
})

test('a whitespace-only prompt keeps Generate inert', async () => {
  const generate = vi.fn(async () => {})
  renderWithStore(<PromptBar />, 'sdxl', { generate })
  await userEvent.type(promptField(), '   ')
  const button = generateButton()
  expect(button.getAttribute('aria-disabled')).toBe('true')
  await userEvent.click(button)
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  expect(generate).not.toHaveBeenCalled()
  expect(localStorage.getItem('fnc.lastPrompt')).toBeNull()
})

test('the prompt bar publishes its height for the gallery and clears it on unmount', () => {
  const { unmount } = renderWithStore(<PromptBar />)
  expect(document.documentElement.style.getPropertyValue('--prompt-bar-h')).toBe('0px')
  unmount()
  expect(document.documentElement.style.getPropertyValue('--prompt-bar-h')).toBe('')
})
