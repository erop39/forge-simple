import { screen } from '@testing-library/react'
import { en } from '../locales/en'
import { ModelCard } from './ModelCard'
import { renderWithStore } from './test-store'

test('a found part shows a check, a missing part shows "Not found"', () => {
  renderWithStore(<ModelCard />, 'sdxl', {
    parts: [
      { role: 'model', value: 'C:\\models\\Stable-diffusion\\sdxl.safetensors', found: true },
      { role: 'module', value: 'ae.safetensors', found: false },
    ],
  })
  const [model, module] = screen.getAllByRole('listitem')
  expect(model!.textContent).toContain(en['params.model'])
  expect(model!.textContent).toContain(en['params.found'])
  expect(model!.textContent).not.toContain(en['params.notFound'])
  const name = screen.getByText('sdxl.safetensors')
  expect(name.classList.contains('mono')).toBe(true)
  expect(module!.textContent).toContain(en['params.module'])
  expect(module!.textContent).toContain(en['params.notFound'])
  expect(module!.textContent).not.toContain(en['params.found'])
})
