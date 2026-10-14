import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { en } from '../locales/en'
import { RestartDialog } from './ForgeRestart'
import { PromptBar } from './PromptBar'
import { renderWithStore } from './test-store'

describe('RestartDialog', () => {
  test('confirming restarts Forge and closes; Cancel closes without a restart', async () => {
    const restartForge = vi.fn(async () => 'restarting' as const)
    const { store } = renderWithStore(<RestartDialog />, 'sdxl', { restartAsked: true, restartForge })
    expect(screen.getByRole('dialog', { name: en['forge.restartTitle'] })).toBeDefined()
    expect(screen.getByText(en['forge.restartBody'])).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: en['forge.restartNo'] }))
    expect(store.getState().restartAsked).toBe(false)
    expect(restartForge).not.toHaveBeenCalled()

    store.getState().askRestart()
    await userEvent.click(await screen.findByRole('button', { name: en['forge.restartYes'] }))
    expect(restartForge).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(store.getState().restartAsked).toBe(false))
  })

  test.each([
    ['notAllowed', en['forge.restartNotAllowed']],
    ['notRestartable', en['forge.restartNotRestartable']],
  ] as const)('a refusal (%s) stays open and explains it', async (outcome, text) => {
    const restartForge = vi.fn(async () => outcome)
    const { store } = renderWithStore(<RestartDialog />, 'sdxl', { restartAsked: true, restartForge })
    await userEvent.click(screen.getByRole('button', { name: en['forge.restartYes'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(text)
    expect(store.getState().restartAsked).toBe(true)
  })

  test('a failed request shows the error text', async () => {
    const restartForge = vi.fn(async () => { throw new Error('error.network') })
    renderWithStore(<RestartDialog />, 'sdxl', { restartAsked: true, restartForge })
    await userEvent.click(screen.getByRole('button', { name: en['forge.restartYes'] }))
    expect((await screen.findByRole('alert')).textContent).toBe(en['error.network'])
  })
})

describe('unhealthy notice', () => {
  test('hidden while Forge is healthy', () => {
    renderWithStore(<PromptBar />)
    expect(screen.queryByText(en['forge.unhealthy'])).toBeNull()
  })

  test('offers Restart (opens the confirmation) and Dismiss when Forge allows restarts', async () => {
    const { store } = renderWithStore(<PromptBar />, 'sdxl', { forgeUnhealthy: true, capabilities: { canRestart: true } })
    expect(screen.getByText(en['forge.unhealthy'])).toBeDefined()
    await userEvent.click(screen.getByRole('button', { name: en['forge.restart'] }))
    expect(store.getState().restartAsked).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: en['notice.dismiss'] }))
    expect(screen.queryByText(en['forge.unhealthy'])).toBeNull()
  })

  test('without the flag it explains how to allow restarts and offers no Restart', () => {
    renderWithStore(<PromptBar />, 'sdxl', { forgeUnhealthy: true })
    expect(screen.getByText(en['forge.unhealthyNoRestart'])).toBeDefined()
    expect(screen.queryByRole('button', { name: en['forge.restart'] })).toBeNull()
  })
})
