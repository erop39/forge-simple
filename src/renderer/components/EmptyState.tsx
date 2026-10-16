import { t } from '../i18n/t'
import { Button } from './ui/Button'
import styles from './EmptyState.module.css'

export function EmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <section className={styles.empty}>
      <h1 className={styles.title}>{t('empty.noServer.title')}</h1>
      <p className={styles.body}>{t('empty.noServer.body')}</p>
      <Button onClick={onConnect}>{t('server.connect')}</Button>
    </section>
  )
}

/** The server answered but offers no checkpoint. */
export function NoModelsState({ onRefresh }: { onRefresh: () => void }) {
  return (
    <section className={styles.empty}>
      <h1 className={styles.title}>{t('empty.noModels.title')}</h1>
      <p className={styles.body}>{t('empty.noModels.body')}</p>
      <Button onClick={onRefresh}>{t('catalog.refresh')}</Button>
    </section>
  )
}

/** A search matched nothing: not the first-run text, the gallery is not empty. */
export function NoResults({ onClear }: { onClear: () => void }) {
  return (
    <section className={styles.empty}>
      <h1 className={styles.title}>{t('search.none.title')}</h1>
      <p className={styles.body}>{t('search.none.body')}</p>
      <Button onClick={onClear}>{t('search.clear')}</Button>
    </section>
  )
}

/** Nothing generated yet. */
export function GalleryEmpty() {
  return (
    <section className={styles.empty}>
      <h1 className={styles.title}>{t('empty.gallery.title')}</h1>
      <p className={styles.body}>{t('empty.gallery.body')}</p>
    </section>
  )
}
