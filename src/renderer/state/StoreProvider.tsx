import { createContext, useContext, type ReactNode } from 'react'
import type { StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { AppState } from './store'

const StoreContext = createContext<StoreApi<AppState> | null>(null)

export function StoreProvider({ store, children }: { store: StoreApi<AppState>; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useAppStore<T>(selector: (state: AppState) => T): T {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useAppStore needs a StoreProvider')
  return useStore(store, selector)
}
