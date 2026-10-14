import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NegativePreset } from '@shared/types'
import { t } from '../i18n/t'
import { en } from '../locales/en'
import type { AppState } from '../state/store'
import { PromptBar } from './PromptBar'
import { renderWithStore } from './test-store'

const blurry: NegativePreset = { id: 1, name: 'Blurry', text: 'blurry, lowres', createdAt: 1 }
const hands: NegativePreset = { id: 2, name: 'Hands', text: 'bad hands', createdAt: 2 }

function setup(negativePrompt: string, state: Partial<AppState> = {}) {
  const actions = {
    addNegativePreset: vi.fn(async () => {}),
    renameNegativePreset: vi.fn(async () => {}),
    removeNegativePreset: vi.fn(async () => {}),
  }
  const rendered = renderWithStore(<PromptBar />, 'sdxl', { negativePresets: [blurry, hands], ...actions, ...state })
  const params = rendered.store.getState().params!
  rendered.store.setState({ params: { ...params, negativePrompt } })
  return { ...rendered, ...actions }
}

const openMenu = () => userEvent.click(screen.getByRole('button', { name: en['presets.menu'] }))
const negativeField = () => screen.queryByRole('textbox', { name: en['prompt.negative'] }) as HTMLTextAreaElement | null

test('choosing a preset replaces the negative text and opens the field', async () => {
  const { store } = setup('old text')
  expect(negativeField()).toBeNull()
  await openMenu()
  await userEvent.click(screen.getByRole('menuitem', { name: 'Hands' }))
  expect(store.getState().params?.negativePrompt).toBe('bad hands')
  expect(negativeField()?.value).toBe('bad hands')
})

test('with no presets the menu says so', async () => {
  setup('x', { negativePresets: [] })
  await openMenu()
  expect(screen.getByRole('menu').textContent).toContain(en['presets.empty'])
})

test('Save current as preset is disabled while the negative is empty', async () => {
  setup('   ')
  await openMenu()
  expect(screen.getByRole('menuitem', { name: en['presets.saveCurrent'] }).getAttribute('aria-disabled')).toBe('true')
})

test('the save dialog creates a preset from the current negative', async () => {
  const { addNegativePreset } = setup('ugly, deformed')
  await openMenu()
  await userEvent.click(screen.getByRole('menuitem', { name: en['presets.saveCurrent'] }))
  const dialog = await screen.findByRole('dialog', { name: en['presets.saveTitle'] })
  const save = within(dialog).getByRole('button', { name: en['presets.save'] }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  const name = within(dialog).getByRole('textbox', { name: en['presets.name'] })
  expect(document.activeElement).toBe(name)
  await userEvent.type(name, ' Ugly ')
  await userEvent.click(save)
  expect(addNegativePreset).toHaveBeenCalledWith('Ugly', 'ugly, deformed')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(screen.getByRole('button', { name: en['presets.menu'] }))
})

test('a taken name keeps the save dialog open with the reason', async () => {
  const addNegativePreset = vi.fn(async () => { throw new Error('error.presetNameTaken') })
  setup('x', { addNegativePreset })
  await openMenu()
  await userEvent.click(screen.getByRole('menuitem', { name: en['presets.saveCurrent'] }))
  const dialog = await screen.findByRole('dialog')
  await userEvent.type(within(dialog).getByRole('textbox', { name: en['presets.name'] }), 'Blurry{Enter}')
  expect(addNegativePreset).toHaveBeenCalledTimes(1)
  expect(within(dialog).getByRole('alert').textContent).toBe(en['error.presetNameTaken'])
})

test('the manage dialog renames a preset inline', async () => {
  const { renameNegativePreset } = setup('x')
  await openMenu()
  await userEvent.click(screen.getByRole('menuitem', { name: en['presets.manage'] }))
  const dialog = await screen.findByRole('dialog', { name: en['presets.manageTitle'] })
  await userEvent.click(within(dialog).getByRole('button', { name: t('presets.rename', { name: 'Blurry' }) }))
  const field = within(dialog).getByRole('textbox', { name: en['presets.name'] }) as HTMLInputElement
  expect(field.value).toBe('Blurry')
  await userEvent.clear(field)
  await userEvent.type(field, 'Soft{Enter}')
  expect(renameNegativePreset).toHaveBeenCalledWith(1, 'Soft')
  await waitFor(() => expect(within(dialog).queryByRole('textbox')).toBeNull())
})

test('the manage dialog deletes a preset after confirmation', async () => {
  const { removeNegativePreset } = setup('x')
  await openMenu()
  await userEvent.click(screen.getByRole('menuitem', { name: en['presets.manage'] }))
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: t('presets.delete', { name: 'Hands' }) }))
  expect(dialog.textContent).toContain(t('presets.deleteConfirm', { name: 'Hands' }))
  expect(removeNegativePreset).not.toHaveBeenCalled()
  await userEvent.click(within(dialog).getByRole('button', { name: en['presets.deleteYes'] }))
  expect(removeNegativePreset).toHaveBeenCalledWith(2)
})

test('the manage dialog shows the empty state', async () => {
  setup('x', { negativePresets: [] })
  await openMenu()
  await userEvent.click(screen.getByRole('menuitem', { name: en['presets.manage'] }))
  expect((await screen.findByRole('dialog')).textContent).toContain(en['presets.empty'])
})

test('a family without a negative has no preset menu', () => {
  renderWithStore(<PromptBar />, 'krea2', { negativePresets: [blurry] })
  expect(screen.queryByRole('button', { name: en['presets.menu'] })).toBeNull()
})
