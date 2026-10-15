import * as Dialog from '@radix-ui/react-dialog'
import { Star, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PROFILES } from '@shared/profiles'
import type { Family, ModelKind } from '@shared/types'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Select } from './ui/Select'
import styles from './ModelGallery.module.css'

const FAMILIES = Object.keys(PROFILES) as Family[]
const ALL = 'all'
const FAVORITES = 'favorites'

interface Item {
  id: string
  name: string
  folder: string
  family: Family | null
  favorite: boolean
  note: string
  previewUrl: string
  hash: string | null
  loaded: boolean
  triggers: string[]
  triggersEdited: boolean
  /** The checkpoint's title (what Forge selects it by) or the LoRA's name (what the prompt tag uses). */
  key: string
  familyOverridden: boolean
}

const folderOf = (path: string): string => {
  const parts = path.split(/[\\/]/)
  return parts.length > 1 ? parts[parts.length - 2]! : ''
}

/** The dialog itself, mounted once in App; it reads which gallery is open from the store. */
export function ModelGalleryDialog() {
  const kind = useAppStore((s) => s.modelGallery)
  const close = useAppStore((s) => s.closeModelGallery)
  return (
    <Dialog.Root open={kind !== null} onOpenChange={(open) => { if (!open) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          {kind !== null && <Gallery kind={kind} onClose={close} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Gallery({ kind, onClose }: { kind: ModelKind; onClose: () => void }) {
  const catalog = useAppStore((s) => s.catalog)
  const params = useAppStore((s) => s.params)
  const selectCheckpoint = useAppStore((s) => s.selectCheckpoint)
  const addLora = useAppStore((s) => s.addLora)
  const setFavorite = useAppStore((s) => s.setModelFavorite)
  const setNote = useAppStore((s) => s.setModelNote)
  const setFamily = useAppStore((s) => s.setCheckpointFamily)
  const setTriggers = useAppStore((s) => s.setLoraTriggers)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState(ALL)
  const [folder, setFolder] = useState(ALL)
  const [selected, setSelected] = useState<string | null>(null)
  const search = useRef<HTMLInputElement>(null)

  const items = useMemo<Item[]>(() => {
    if (!catalog) return []
    if (kind === 'checkpoint') {
      return catalog.checkpoints.map((c) => ({
        id: c.filename, key: c.title, name: c.name,
        folder: folderOf(c.filename), family: c.family, favorite: c.favorite ?? false, note: c.note ?? '',
        previewUrl: c.previewUrl ?? '', hash: c.sha256 ?? c.hash ?? null, loaded: catalog.loadedCheckpoint === c.title,
        triggers: [], triggersEdited: false, familyOverridden: c.familyOverridden ?? false,
      }))
    }
    return catalog.loras.map((l) => ({
      id: l.path, key: l.name, name: l.alias || l.name, folder: folderOf(l.path), family: l.baseFamily ?? null,
      favorite: l.favorite ?? false, note: l.note ?? '', previewUrl: l.previewUrl ?? '', hash: null, loaded: false,
      triggers: l.triggers ?? [], triggersEdited: l.triggersEdited ?? false, familyOverridden: false,
    }))
  }, [catalog, kind])

  const folders = useMemo(() => [...new Set(items.map((i) => i.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [items])
  const counts = useMemo(() => {
    const out = new Map<string, number>()
    for (const item of items) if (item.family) out.set(item.family, (out.get(item.family) ?? 0) + 1)
    return out
  }, [items])
  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => items
    .filter((i) => (filter === ALL ? true : filter === FAVORITES ? i.favorite : i.family === filter))
    .filter((i) => folder === ALL || i.folder === folder)
    .filter((i) => needle === '' || `${i.folder}/${i.name}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)), [items, filter, folder, needle])

  const current = items.find((i) => i.id === selected) ?? null
  useEffect(() => { search.current?.focus() }, [])

  const inStack = (name: string): boolean => params?.loras.some((l) => l.name === name) ?? false
  const stackFull = (params?.loras.length ?? 0) >= 16
  const checkpointInUse = (item: Item): boolean => params?.checkpoint === item.key

  function choose(item: Item): void {
    if (kind === 'checkpoint') {
      void selectCheckpoint(item.key)
      onClose()
    } else {
      addLora(item.key)
    }
  }

  const title = kind === 'checkpoint' ? t('models.checkpointsTitle') : t('models.lorasTitle')
  const filterOptions = [
    { value: ALL, label: `${t('models.filterAll')} (${items.length})` },
    { value: FAVORITES, label: `${t('models.filterFavorites')} (${items.filter((i) => i.favorite).length})` },
    ...FAMILIES.filter((f) => counts.has(f)).map((f) => ({ value: f, label: `${t(`family.${f}`)} (${counts.get(f)})` })),
  ]

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.head}>
          <Dialog.Title className={styles.title}>{title}</Dialog.Title>
          <span className={`mono ${styles.count}`}>{t('models.count', { shown: shown.length, total: items.length })}</span>
          <IconButton label={t('models.close')} icon={<X size={20} />} onClick={onClose} />
        </div>
        <div className={styles.toolbar}>
          <input
            ref={search}
            className={styles.search}
            type="search"
            aria-label={t('models.search')}
            placeholder={t('models.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select label={t('models.family')} value={filter} options={filterOptions} onChange={setFilter} />
          {folders.length > 1 && (
            <Select label={t('models.folder')} value={folder}
              options={[{ value: ALL, label: t('models.allFolders') }, ...folders.map((f) => ({ value: f, label: f }))]}
              onChange={setFolder} />
          )}
        </div>
        {shown.length === 0 ? (
          <p className={styles.empty}>{t('models.empty')}</p>
        ) : (
          <ul className={styles.grid} aria-label={title}>
            {shown.map((item) => (
              <li key={item.id} className={styles.cell}>
                <button
                  type="button"
                  className={`${styles.card} ${item.id === selected ? styles.cardSelected : ''}`}
                  aria-label={t('models.select', { name: item.name })}
                  aria-pressed={item.id === selected}
                  onClick={() => setSelected(item.id)}
                  onDoubleClick={() => choose(item)}
                >
                  <Preview url={item.previewUrl} name={item.name} />
                  <span className={styles.cardName}>{item.name}</span>
                  <span className={styles.cardMeta}>
                    {item.family && <span className={styles.chip}>{t(`family.${item.family}`)}</span>}
                    {item.loaded && <span className={`${styles.chip} ${styles.chipLoaded}`}>{t('models.loaded')}</span>}
                    {kind === 'lora' && item.family && params && item.family !== params.family && (
                      <span className={`${styles.chip} ${styles.chipWarn}`}>{t('models.otherFamily', { family: t(`family.${item.family}`) })}</span>
                    )}
                  </span>
                </button>
                {item.favorite && <Star size={16} weight="fill" className={styles.star} aria-hidden="true" />}
              </li>
            ))}
          </ul>
        )}
      </div>
      <aside className={styles.side} aria-label={t('models.path')}>
        {current ? (
          <Details
            key={current.id}
            kind={kind}
            item={current}
            primary={kind === 'checkpoint'
              ? { label: checkpointInUse(current) ? t('models.inUse') : t('models.use'), disabled: checkpointInUse(current) }
              : { label: inStack(current.key) ? t('models.added') : t('models.add'), disabled: inStack(current.key) || stackFull }}
            note={kind === 'lora' && stackFull && !inStack(current.key) ? t('models.stackFull') : null}
            onPrimary={() => choose(current)}
            onFavorite={(favorite) => void setFavorite(kind, current.id, favorite)}
            onNote={(note) => void setNote(kind, current.id, note)}
            onFamily={(family) => void setFamily(current.id, family)}
            onTriggers={(triggers) => void setTriggers(current.id, triggers)}
          />
        ) : (
          <p className={styles.hint}>{t('models.select', { name: title })}</p>
        )}
      </aside>
    </div>
  )
}

function Preview({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false)
  if (url === '' || failed) {
    return <span className={styles.placeholder} aria-label={t('models.noPreview')}>{name.slice(0, 1).toUpperCase()}</span>
  }
  return <img className={styles.preview} src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
}

type DetailsProps = {
  kind: ModelKind
  item: Item
  primary: { label: string; disabled: boolean }
  note: string | null
  onPrimary(): void
  onFavorite(favorite: boolean): void
  onNote(note: string): void
  onFamily(family: Family | null): void
  onTriggers(triggers: string[] | null): void
}

function Details({ kind, item, primary, note, onPrimary, onFavorite, onNote, onFamily, onTriggers }: DetailsProps) {
  const [noteDraft, setNoteDraft] = useState(item.note)
  const [word, setWord] = useState('')
  const detected = item.familyOverridden ? null : item.family

  function addWord(): void {
    const next = word.trim()
    if (next === '' || item.triggers.includes(next)) { setWord(''); return }
    onTriggers([...item.triggers, next])
    setWord('')
  }

  return (
    <div className={styles.details}>
      <div className={styles.detailPreview}><Preview url={item.previewUrl} name={item.name} /></div>
      <h3 className={styles.detailName}>{item.name}</h3>
      <div className={styles.detailActions}>
        <Button variant="primary" disabled={primary.disabled} onClick={onPrimary}>{primary.label}</Button>
        <IconButton
          label={item.favorite ? t('models.unfavorite') : t('models.favorite')}
          icon={<Star size={20} weight={item.favorite ? 'fill' : 'regular'} />}
          aria-pressed={item.favorite}
          onClick={() => onFavorite(!item.favorite)}
        />
      </div>
      {note && <p className={styles.hint}>{note}</p>}
      {kind === 'checkpoint' && (
        <label className={styles.field}>
          <span className={styles.label}>{t('models.setFamily')}</span>
          <Select
            label={t('models.setFamily')}
            showLabel={false}
            value={item.familyOverridden ? (item.family as string) : 'auto'}
            options={[
              { value: 'auto', label: t('models.familyAuto') },
              ...FAMILIES.map((f) => ({ value: f, label: t(`family.${f}`) })),
            ]}
            onChange={(value) => onFamily(value === 'auto' ? null : (value as Family))}
          />
          {detected && <span className={styles.hint}>{t('models.detectedFamily', { family: t(`family.${detected}`) })}</span>}
        </label>
      )}
      {kind === 'lora' && (
        <section className={styles.field}>
          <span className={styles.label}>{t('models.triggers')}</span>
          {item.triggers.length === 0 ? (
            <span className={styles.hint}>{t('models.triggersNone')}</span>
          ) : (
            <ul className={styles.words}>
              {item.triggers.map((trigger) => (
                <li key={trigger} className={styles.word}>
                  <span>{trigger}</span>
                  <button type="button" className={styles.wordRemove} aria-label={t('models.triggerRemove', { word: trigger })}
                    onClick={() => onTriggers(item.triggers.filter((w) => w !== trigger))}>
                    <X size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            className={styles.input}
            aria-label={t('models.triggerAdd')}
            placeholder={t('models.triggerAdd')}
            value={word}
            onChange={(event) => setWord(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addWord() } }}
          />
          {item.triggersEdited && <Button onClick={() => onTriggers(null)}>{t('models.triggersReset')}</Button>}
        </section>
      )}
      <label className={styles.field}>
        <span className={styles.label}>{t('models.note')}</span>
        <textarea
          className={styles.input}
          rows={3}
          placeholder={t('models.notePlaceholder')}
          value={noteDraft}
          maxLength={2000}
          onChange={(event) => setNoteDraft(event.target.value)}
          onBlur={() => { if (noteDraft.trim() !== item.note) onNote(noteDraft) }}
        />
      </label>
      <dl className={styles.facts}>
        <dt>{t('models.path')}</dt>
        <dd className="mono" title={item.id}>{item.id}</dd>
        {item.hash && (<><dt>{t('models.hash')}</dt><dd className="mono">{item.hash.slice(0, 16)}</dd></>)}
      </dl>
    </div>
  )
}
