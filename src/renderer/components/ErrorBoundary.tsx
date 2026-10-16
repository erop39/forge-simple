import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../i18n/t'
import { Button } from './ui/Button'
import styles from './EmptyState.module.css'

type Props = { children: ReactNode; onReload?: () => void }

/** Catches a crash while rendering so the window shows a message and a Reload button instead of going blank. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('renderer crashed', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <section className={styles.empty} role="alert">
        <h1 className={styles.title}>{t('crash.title')}</h1>
        <p className={styles.body}>{t('crash.body')}</p>
        <Button autoFocus onClick={this.props.onReload ?? (() => window.location.reload())}>{t('crash.reload')}</Button>
      </section>
    )
  }
}
