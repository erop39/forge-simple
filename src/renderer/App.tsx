import { useEffect, useState } from 'react'
import { t } from './i18n/t'
import { useAppStore } from './state/StoreProvider'
import { EmptyState } from './components/EmptyState'
import { Notice } from './components/ui/Notice'
import { ServerDialog } from './components/ServerDialog'
import { TopBar } from './components/TopBar'
import styles from './App.module.css'

export function App() {
  const init = useAppStore((s) => s.init)
  const settings = useAppStore((s) => s.settings)
  const lastError = useAppStore((s) => s.lastError)
  const dismissError = useAppStore((s) => s.dismissError)
  const catalogError = useAppStore((s) => s.catalogError)
  const retryCatalog = useAppStore((s) => s.retryCatalog)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  const noServer = settings !== null && !settings.serverUrl
  const openDialog = () => setDialogOpen(true)

  return (
    <div className={styles.shell}>
      <TopBar onOpenServer={openDialog} />
      <main className={styles.content}>
        {catalogError !== null && (
          <Notice text={t(catalogError)} action={{ label: t('catalog.retry'), onClick: () => void retryCatalog() }} />
        )}
        {lastError !== null && <Notice text={t(lastError)} onDismiss={dismissError} />}
        {noServer && <EmptyState onConnect={openDialog} />}
      </main>
      <ServerDialog open={dialogOpen || noServer} onOpenChange={setDialogOpen} />
    </div>
  )
}
