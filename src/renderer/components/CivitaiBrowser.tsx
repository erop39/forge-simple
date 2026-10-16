import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, ArrowSquareOut, BookmarkSimple, CheckCircle, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { CivitaiBrowseItem, CivitaiBrowseQuery, ModelKind } from '@shared/types'
import { errorText } from '../i18n/error-text'
import { LOCALE, t, type MessageKey } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { MultiSelect } from './ui/MultiSelect'
import { Select } from './ui/Select'
import styles from './CivitaiBrowser.module.css'

const PERIODS = ['day', 'week', 'month'] as const
const SORTS = ['newest', 'downloads', 'rating'] as const
/** Civitai's own names for the base models. */
const BASES = [
  // The families this app knows first, then the other common ones (each name was checked against Civitai's filter).
  'SDXL 1.0', 'ZImageTurbo', 'ZImageBase', 'Krea 2', 'Krea 2 Turbo', 'Qwen', 'Lumina', 'Anima',
  'Illustrious', 'Pony', 'NoobAI', 'SD 1.5', 'Flux.1 D', 'Flux.1 S', 'Flux.1 Krea', 'Flux.2 D', 'Flux.2 Klein 9B', 'Flux.3 Klein', 'Chroma', 'HiDream',
] as const
/** A friendlier name for a few of Civitai's; the filter still sends Civitai's own. */
const BASE_LABELS: Record<string, string> = { ZImageTurbo: 'Z-Image Turbo', ZImageBase: 'Z-Image Base' }
const SITE_KEY = 'fnc.civitaiSite'
const readSite = (): 'com' | 'red' => {
  try { return localStorage.getItem(SITE_KEY) === 'red' ? 'red' : 'com' } catch { return 'com' }
}
const day = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' })
const count = new Intl.NumberFormat(LOCALE, { notation: 'compact' })

/** The Civitai browser, mounted once in App; it reads which kind is open from the store. */
export function CivitaiBrowserDialog() {
  const kind = useAppStore((s) => s.civitaiBrowser)
  const close = useAppStore((s) => s.closeCivitaiBrowser)
  const back = useAppStore((s) => s.backFromCivitaiBrowser)
  return (
    <Dialog.Root open={kind !== null} onOpenChange={(open) => { if (!open) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          {kind !== null && <Browser initialKind={kind} onClose={close} onBack={back} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Browser({ initialKind, onClose, onBack }: { initialKind: ModelKind; onClose(): void; onBack(): void }) {
  const consent = useAppStore((s) => s.settings?.civitaiEnabled === true)
  const setCivitaiEnabled = useAppStore((s) => s.setCivitaiEnabled)
  const browse = useAppStore((s) => s.browseCivitai)
  const openModel = useAppStore((s) => s.openCivitaiModel)
  const wishlist = useAppStore((s) => s.wishlist)
  const addToWishlist = useAppStore((s) => s.addToWishlist)
  const removeFromWishlist = useAppStore((s) => s.removeFromWishlist)
  const [view, setView] = useState<'browse' | 'later'>('browse')
  const [wishError, setWishError] = useState<string | null>(null)
  const [kind, setKind] = useState<ModelKind>(initialKind)
  const [site, setSite] = useState<'com' | 'red'>(readSite)
  const [period, setPeriod] = useState<CivitaiBrowseQuery['period']>('week')
  const [sort, setSort] = useState<CivitaiBrowseQuery['sort']>('newest')
  const [bases, setBases] = useState<string[]>([])
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [items, setItems] = useState<CivitaiBrowseItem[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  async function load(cursor: string | null): Promise<void> {
    const mine = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const page = await browse({ site, kind, period, sort, baseModels: bases, text: submitted, cursor })
      if (mine !== seq.current) return
      setItems((old) => (cursor === null ? page.items : [...old, ...page.items.filter((n) => !old.some((o) => o.versionId === n.versionId))]))
      setNext(page.next)
    } catch (e) {
      if (mine !== seq.current) return
      setError(errorText(e))
      if (cursor === null) { setItems([]); setNext(null) }
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (consent) void load(null)
    else seq.current++
    // `load` reads the filters above; a change of any of them starts a new listing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consent, site, kind, period, sort, bases, submitted])

  const wished = (item: { modelId: number; versionId: number }) =>
    wishlist.find((w) => w.modelId === item.modelId && w.versionId === item.versionId)
  async function toggleWish(item: CivitaiBrowseItem): Promise<void> {
    setWishError(null)
    try {
      const have = wished(item)
      if (have) await removeFromWishlist(have.id)
      else await addToWishlist(item.modelId, item.versionId)
    } catch (e) {
      setWishError(errorText(e))
    }
  }

  return (
    <div className={styles.layout}>
      <div className={styles.head}>
        <IconButton label={t('browser.back')} icon={<ArrowLeft size={20} />} onClick={onBack} />
        <Dialog.Title className={styles.title}>{t('browser.title')}</Dialog.Title>
        <div className={styles.views} role="group" aria-label={t('browser.views')}>
          <Button aria-pressed={view === 'browse'} variant={view === 'browse' ? 'primary' : 'plain'} onClick={() => setView('browse')}>{t('browser.viewBrowse')}</Button>
          <Button aria-pressed={view === 'later'} variant={view === 'later' ? 'primary' : 'plain'} onClick={() => setView('later')}>{t('browser.viewLater', { n: wishlist.length })}</Button>
        </div>
        <IconButton label={t('models.close')} icon={<X size={20} />} onClick={onClose} />
      </div>
      {!consent ? (
        <div className={styles.consent} role="alertdialog" aria-label={t('browser.consentTitle')}>
          <strong>{t('browser.consentTitle')}</strong>
          <p>{t('browser.consentBody')}</p>
          <div className={styles.consentActions}>
            <Button variant="primary" autoFocus onClick={() => void setCivitaiEnabled(true)}>{t('browser.consentAllow')}</Button>
            <Button onClick={onClose}>{t('civitai.consentNo')}</Button>
          </div>
        </div>
      ) : view === 'later' ? (
        <>
          <p className={styles.hint}>{t('later.hint')}</p>
          {wishError && <p role="alert" className={styles.error}>{wishError}</p>}
          {wishlist.length === 0 && <p className={styles.empty}>{t('later.empty')}</p>}
          <ul className={styles.grid} aria-label={t('later.title')}>
            {wishlist.map((w) => (
              <li key={w.id} className={styles.item}>
                <div className={styles.card}>
                  <span className={styles.frame}>
                    {w.thumb ? <img className={styles.thumb} src={w.thumb} alt="" /> : <span className={styles.noThumb}>{t('browser.noPreview')}</span>}
                  </span>
                  <span className={styles.name} title={w.name}>{w.name}</span>
                  <span className={styles.meta}>{[w.baseModel, w.versionName].filter((x) => x !== '').join(' · ')}</span>
                  <span className={styles.meta}>{[w.kind === 'lora' ? t('browser.loras') : t('browser.checkpoints'), w.creator].filter((x) => x !== '').join(' · ')}</span>
                  <div className={styles.cardActions}>
                    <IconButton label={t('browser.open')} icon={<ArrowSquareOut size={20} />} onClick={() => void openModel(w.modelId, w.versionId, w.site)} />
                    <IconButton label={t('later.markDownloaded')} icon={<CheckCircle size={20} />} onClick={() => void removeFromWishlist(w.id)} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className={styles.toolbar}>
            <Select label={t('browser.site')} value={site} onChange={(v) => {
              const next = v === 'red' ? 'red' : 'com'
              try { localStorage.setItem(SITE_KEY, next) } catch { /* the choice just does not outlive the session */ }
              setSite(next)
            }}
              options={[{ value: 'com', label: t('browser.site.com') }, { value: 'red', label: t('browser.site.red') }]} />
            <Select label={t('browser.kind')} value={kind} onChange={(v) => setKind(v as ModelKind)}
              options={[{ value: 'checkpoint', label: t('browser.checkpoints') }, { value: 'lora', label: t('browser.loras') }]} />
            <Select label={t('browser.period')} value={period} onChange={(v) => setPeriod(v as typeof period)}
              options={PERIODS.map((p) => ({ value: p, label: t(`browser.period.${p}` as MessageKey) }))} />
            <Select label={t('browser.sort')} value={sort} onChange={(v) => setSort(v as typeof sort)}
              options={SORTS.map((s) => ({ value: s, label: t(`browser.sort.${s}` as MessageKey) }))} />
            <MultiSelect label={t('browser.base')} values={bases} onChange={setBases} clearLabel={t('browser.baseClear')}
              summary={bases.length === 0 ? t('browser.baseAny') : bases.length === 1 ? (BASE_LABELS[bases[0]!] ?? bases[0]!) : t('browser.baseMany', { n: bases.length })}
              options={BASES.map((b) => ({ value: b, label: BASE_LABELS[b] ?? b }))} />
            <input className={styles.search} type="search" aria-label={t('browser.search')} placeholder={t('browser.search')}
              value={text} maxLength={100} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSubmitted(text.trim()) }} />
          </div>
          {site === 'red' && <p className={styles.hint}>{t('browser.redNotice')}</p>}
          {error && <p role="alert" className={styles.error}>{error}</p>}
          {wishError && <p role="alert" className={styles.error}>{wishError}</p>}
          {!error && !loading && items.length === 0 && <p className={styles.empty}>{t('browser.empty')}</p>}
          <ul className={styles.grid}>
            {items.map((item) => (
              <li key={`${item.modelId}-${item.versionId}`} className={styles.item}>
                <button type="button" className={styles.card} onClick={() => void openModel(item.modelId, item.versionId, site)}
                  title={t('browser.open')}>
                  <span className={styles.frame}>
                    {item.thumb ? <img className={styles.thumb} src={item.thumb} alt="" /> : <span className={styles.noThumb}>{t(site === 'com' ? 'browser.noPreviewSafe' : 'browser.noPreview')}</span>}
                    {item.inLibrary && (
                      <span className={`${styles.mark} ${item.inLibrary === 'have' ? styles.markHave : styles.markOlder}`}>
                        {t(item.inLibrary === 'have' ? 'browser.have' : 'browser.older')}
                      </span>
                    )}
                    <span className={styles.open} aria-hidden><ArrowSquareOut size={14} /></span>
                  </span>
                  <span className={styles.name}>{item.name}</span>
                  <span className={styles.meta}>
                    {[item.baseModel, item.versionName].filter((x) => x !== '').join(' · ')}
                  </span>
                  <span className={styles.meta}>
                    {[item.publishedAt ? day.format(item.publishedAt) : '', item.creator, t('browser.downloads', { n: count.format(item.downloads) })].filter((x) => x !== '').join(' · ')}
                  </span>
                </button>
                <IconButton className={styles.bookmark} label={t(wished(item) ? 'later.remove' : 'later.add')} aria-pressed={wished(item) !== undefined}
                  icon={<BookmarkSimple size={16} weight={wished(item) ? 'fill' : 'regular'} />} onClick={() => void toggleWish(item)} />
              </li>
            ))}
          </ul>
          <div className={styles.foot}>
            {loading && <span role="status" className={styles.hint}>{t('browser.loading')}</span>}
            {!loading && next !== null && <Button onClick={() => void load(next)}>{t('browser.more')}</Button>}
          </div>
        </>
      )}
    </div>
  )
}
