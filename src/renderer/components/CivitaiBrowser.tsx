import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, ArrowSquareOut, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { CivitaiBrowseItem, CivitaiBrowseQuery, ModelKind } from '@shared/types'
import { errorText } from '../i18n/error-text'
import { LOCALE, t, type MessageKey } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Select } from './ui/Select'
import styles from './CivitaiBrowser.module.css'

const PERIODS = ['day', 'week', 'month'] as const
const SORTS = ['newest', 'downloads', 'rating'] as const
/** Civitai's own names for the base models; '' = any. */
const BASES = ['', 'SD 1.5', 'SDXL 1.0', 'Pony', 'Illustrious', 'Flux.1 D', 'Flux.1 S', 'SD 3.5', 'Qwen', 'Anima'] as const
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
  const [kind, setKind] = useState<ModelKind>(initialKind)
  const [site, setSite] = useState<'com' | 'red'>(readSite)
  const [period, setPeriod] = useState<CivitaiBrowseQuery['period']>('week')
  const [sort, setSort] = useState<CivitaiBrowseQuery['sort']>('newest')
  const [base, setBase] = useState('')
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
      const page = await browse({ site, kind, period, sort, baseModels: base === '' ? [] : [base], text: submitted, cursor })
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
  }, [consent, site, kind, period, sort, base, submitted])

  return (
    <div className={styles.layout}>
      <div className={styles.head}>
        <IconButton label={t('browser.back')} icon={<ArrowLeft size={20} />} onClick={onBack} />
        <Dialog.Title className={styles.title}>{t('browser.title')}</Dialog.Title>
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
            <Select label={t('browser.base')} value={base} onChange={setBase}
              options={BASES.map((b) => ({ value: b, label: b === '' ? t('browser.baseAny') : b }))} />
            <input className={styles.search} type="search" aria-label={t('browser.search')} placeholder={t('browser.search')}
              value={text} maxLength={100} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSubmitted(text.trim()) }} />
          </div>
          {site === 'red' && <p className={styles.hint}>{t('browser.redNotice')}</p>}
          {error && <p role="alert" className={styles.error}>{error}</p>}
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
