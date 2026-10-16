import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '../locales/en'
import { PresetMenu } from './PresetMenu'
import { renderWithStore } from './test-store'

const preset = (id: number, name: string) => ({ id, name, createdAt: 1, params: {
  family: 'sdxl' as const, checkpoint: 'sdxl.safetensors', modules: [], width: 640, height: 640, steps: 17, cfgScale: 6,
  distilledCfg: 3.5, shift: null, clipSkip: 2, sampler: 'Euler', scheduler: 'Simple', loras: [] } })

test('picking a preset applies it and keeps prompt, negative, seed and image count', async () => {
  const applyPreset = vi.fn()
  renderWithStore(<PresetMenu />, 'sdxl', { presets: [preset(1, 'Square'), preset(2, 'Wide')], applyPreset })
  await userEvent.click(screen.getByRole('button', { name: en['preset.menu'] }))
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Wide' }))
  expect(applyPreset).toHaveBeenCalledWith(expect.objectContaining({ id: 2, name: 'Wide' }))
})

test('the store applies a preset over the current settings without touching prompt, negative, seed or count', () => {
  const { store } = renderWithStore(<PresetMenu />, 'sdxl', {})
  store.getState().setParams({ prompt: 'keep me', negativePrompt: 'keep negative', seed: 77, count: 3 })
  store.getState().applyPreset(preset(1, 'Square'))
  expect(store.getState().params).toMatchObject({ prompt: 'keep me', negativePrompt: 'keep negative', seed: 77, count: 3,
    width: 640, steps: 17, cfgScale: 6, scheduler: 'Simple' })
  expect(store.getState().draftPrompt).toBe('keep me')
})

test('Save as preset names the current settings; a taken name is reported and the dialog stays open', async () => {
  const savePreset = vi.fn(async () => { throw new Error('error.presetNameTaken') })
  renderWithStore(<PresetMenu />, 'sdxl', { savePreset, presets: [] })
  await userEvent.click(screen.getByRole('button', { name: en['preset.menu'] }))
  expect(await screen.findByText(en['preset.empty'])).toBeDefined()
  await userEvent.click(screen.getByRole('menuitem', { name: en['preset.save'] }))
  const dialog = await screen.findByRole('dialog')
  const save = within(dialog).getByRole('button', { name: en['preset.saveConfirm'] }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  await userEvent.type(within(dialog).getByRole('textbox'), 'Portrait{Enter}')
  expect(savePreset).toHaveBeenCalledWith('Portrait')
  expect(await within(dialog).findByRole('alert')).toBeDefined()
  expect(screen.getByRole('dialog')).toBeDefined()
})

test('Manage presets renames inline and deletes after a confirmation', async () => {
  const renamePreset = vi.fn(async () => undefined)
  const deletePreset = vi.fn(async () => undefined)
  renderWithStore(<PresetMenu />, 'sdxl', { presets: [preset(1, 'Square')], renamePreset, deletePreset })
  await userEvent.click(screen.getByRole('button', { name: en['preset.menu'] }))
  await userEvent.click(await screen.findByRole('menuitem', { name: en['preset.manage'] }))
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Rename Square' }))
  const field = within(dialog).getByRole('textbox')
  await userEvent.clear(field)
  await userEvent.type(field, 'Round{Enter}')
  expect(renamePreset).toHaveBeenCalledWith(1, 'Round')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Square' }))
  expect(deletePreset).not.toHaveBeenCalled()
  await userEvent.click(within(dialog).getByRole('button', { name: en['preset.deleteYes'] }))
  expect(deletePreset).toHaveBeenCalledWith(1)
})
