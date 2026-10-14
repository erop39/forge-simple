import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Api } from '@shared/ipc'
import { defaultParams } from '@shared/profiles'
import type { Catalog, Family, GenerationParams } from '@shared/types'
import { createAppStore, type AppState } from '../state/store'
import { StoreProvider } from '../state/StoreProvider'

export const catalog: Catalog = {
  checkpoints: [
    { title: 'sdxl.safetensors', name: 'sdxl', filename: 'sdxl.safetensors', family: 'sdxl' },
    { title: 'krea.safetensors', name: 'krea', filename: 'krea.safetensors', family: 'krea2' },
  ],
  modules: [
    { name: 'ae.safetensors', filename: 'C:\\models\\VAE\\ae.safetensors' },
    { name: 'clip.safetensors', filename: 'C:\\models\\text_encoder\\clip.safetensors' },
  ],
  loras: [],
  samplers: ['Euler', 'DPM++ 2M'],
  schedulers: ['Simple', 'Karras'],
  upscalers: [],
  loadedCheckpoint: null,
  fetchedAt: 1,
  familyModules: {},
}

/** A store holding the given family's default parameters, rendered with `ui`. Actions can be replaced through `state`. */
export function renderWithStore(ui: ReactNode, family: Family = 'sdxl', state: Partial<AppState> = {}) {
  const api = { catalog: { parts: async () => [] } } as unknown as Api
  const store = createAppStore(api)
  const params: GenerationParams = defaultParams(family, `${family}.safetensors`, catalog)
  store.setState({ catalog, params, ...state })
  return { store, ...render(<StoreProvider store={store}>{ui}</StoreProvider>) }
}
