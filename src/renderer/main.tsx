import '@fontsource-variable/onest'
import '@fontsource/jetbrains-mono/400.css'
import './styles/tokens.css'
import './styles/base.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { createAppStore } from './state/store'
import { StoreProvider } from './state/StoreProvider'

const store = createAppStore(window.api)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <StoreProvider store={store}>
        <App />
      </StoreProvider>
    </ErrorBoundary>
  </StrictMode>,
)
