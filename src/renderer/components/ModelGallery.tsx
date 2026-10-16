import * as Dialog from '@radix-ui/react-dialog'
import { CloudArrowDown, Star, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { PROFILES } from '@shared/profiles'
import type { CivitaiLink, Family, ModelKind } from '@shared/types'
import { LOCALE, t, type MessageKey } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Select } from './ui/Select'
import styles from './ModelGallery.module.css'

const FAMILIES = Object.keys(PROFILES) as Family[]
const ALL = 'all'
const FAVORITES = 'favorites'
const NEWER = 'newer'
const DUPLICATES = 'duplicates'

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
  civitai: CivitaiLink | null
  duplicates: string[]
  addedAt: number | null
  releasedAt: number | null
  uses: number
  lastUsedAt: number | null
}

type Sort = 'name' | 'added' | 'released' | 'used' | 'lastUsed'
const SORTS: readonly Sort[] = ['name', 'added', 'released', 'used', 'lastUsed']
const day = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' })

/** The value a sort puts first (the newest, the most used); null when the file has none, which sorts last. */
function sortKey(item: Item, sort: Sort): number | null {
  if (sort === 'added') return item.addedAt
  if (sort === 'released') return item.releasedAt
  if (sort === 'used') return item.uses > 0 ? item.uses : null
  if (sort === 'lastUsed') return item.lastUsedAt
  return null
}

const groupKey = (item: Item): string => [item.id, ...item.duplicates].sort()[0]!

/** What the active sort is about, shown on the card: a date or a count. */
function cardStat(item: Item, sort: Sort): string | null {
  const key = sortKey(item, sort)
  if (key === null) return null
  return sort === 'used' ? t('models.usedTimes', { n: item.uses }) : day.format(key)
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
  const setTriggers = useAppStore((s) => s.setModelTriggers)
  const civitai = useAppStore((s) => s.civitai)
  const consent = useAppStore((s) => s.settings?.civitaiEnabled === true)
  const setCivitaiEnabled = useAppStore((s) => s.setCivitaiEnabled)
  const updateFromCivitai = useAppStore((s) => s.updateFromCivitai)
  const cancelCivitai = useAppStore((s) => s.cancelCivitai)
  const openOnCivitai = useAppStore((s) => s.openOnCivitai)
  const [asking, setAsking] = useState(false)
  const [askFor, setAskFor] = useState<{ kind: ModelKind; id: string } | null>(null)
  const updateOne = useAppStore((s) => s.updateModelFromCivitai)
  const insertWord = useAppStore((s) => s.insertPromptWord)
  const [oneResult, setOneResult] = useState<{ id: string; result: string } | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState(ALL)
  const [folder, setFolder] = useState(ALL)
  const [sort, setSort] = useState<Sort>('name')
  const [selected, setSelected] = useState<string | null>(null)
  const search = useRef<HTMLInputElement>(null)

  async function runOne(target: { kind: ModelKind; id: string }): Promise<void> {
    setOneResult({ id: target.id, result: 'running' })
    setOneResult({ id: target.id, result: await updateOne(target.kind, target.id) })
  }

  async function startUpdate(): Promise<void> {
    if (!consent) await setCivitaiEnabled(true)
    setAsking(false)
    if (askFor) {
      const target = askFor
      setAskFor(null)
      await runOne(target)
    } else {
      await updateFromCivitai()
    }
  }

  const items = useMemo<Item[]>(() => {
    if (!catalog) return []
    if (kind === 'checkpoint') {
      return catalog.checkpoints.map((c) => ({
        id: c.filename, key: c.title, name: c.name,
        folder: folderOf(c.filename), family: c.family, favorite: c.favorite ?? false, note: c.note ?? '',
        previewUrl: c.previewUrl ?? '', hash: c.sha256 ?? c.hash ?? null, loaded: catalog.loadedCheckpoint === c.title,
        triggers: c.triggers ?? [], triggersEdited: c.triggersEdited ?? false, familyOverridden: c.familyOverridden ?? false, civitai: c.civitai ?? null, duplicates: c.duplicates ?? [],
        addedAt: c.addedAt ?? null, releasedAt: c.releasedAt ?? null, uses: c.uses ?? 0, lastUsedAt: c.lastUsedAt ?? null,
      }))
    }
    return catalog.loras.map((l) => ({
      id: l.path, key: l.name, name: l.alias || l.name, folder: folderOf(l.path), family: l.baseFamily ?? null,
      favorite: l.favorite ?? false, note: l.note ?? '', previewUrl: l.previewUrl ?? '', hash: l.hash ?? null, loaded: false,
      triggers: l.triggers ?? [], triggersEdited: l.triggersEdited ?? false, familyOverridden: false, civitai: l.civitai ?? null, duplicates: l.duplicates ?? [],
      addedAt: l.addedAt ?? null, releasedAt: l.releasedAt ?? null, uses: l.uses ?? 0, lastUsedAt: l.lastUsedAt ?? null,
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
    .filter((i) => (filter === ALL ? true : filter === FAVORITES ? i.favorite : filter === NEWER ? i.civitai?.newer != null
      : filter === DUPLICATES ? i.duplicates.length > 0 : i.family === filter))
    .filter((i) => folder === ALL || i.folder === folder)
    .filter((i) => needle === '' || `${i.folder}/${i.name}`.toLowerCase().includes(needle))
    .sort((a, b) => {
      // Copies of one model sit side by side: groups are ordered by their first member.
      if (filter === DUPLICATES) return groupKey(a).localeCompare(groupKey(b)) || a.id.localeCompare(b.id)
      if (sort === 'name') return Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)
      const ka = sortKey(a, sort)
      const kb = sortKey(b, sort)
      if (ka === null && kb === null) return a.name.localeCompare(b.name)
      if (ka === null) return 1
      if (kb === null) return -1
      return kb - ka || a.name.localeCompare(b.name)
    }), [items, filter, folder, needle, sort])

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
    ...(items.some((i) => i.civitai?.newer) ? [{ value: NEWER, label: `${t('models.filterNewer')} (${items.filter((i) => i.civitai?.newer).length})` }] : []),
    ...(items.some((i) => i.duplicates.length > 0) ? [{ value: DUPLICATES, label: `${t('models.filterDuplicates')} (${items.filter((i) => i.duplicates.length > 0).length})` }] : []),
    ...FAMILIES.filter((f) => counts.has(f)).map((f) => ({ value: f, label: `${t(`family.${f}`)} (${counts.get(f)})` })),
  ]

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        <div className={styles.head}>
          <Dialog.Title className={styles.title}>{title}</Dialog.Title>
          <span className={`mono ${styles.count}`}>{t('models.count', { shown: shown.length, total: items.length })}</span>
          {civitai.running ? (
            <>
              <span className={styles.progress} role="status">
                {t(civitai.paused ? 'civitai.paused' : 'civitai.running', { done: civitai.done, total: civitai.total })}
              </span>
              <Button onClick={() => void cancelCivitai()}>{t('civitai.cancel')}</Button>
            </>
          ) : (
            <Button icon={<CloudArrowDown size={16} />} onClick={() => (consent ? void startUpdate() : setAsking(true))}>
              {t('civitai.update')}
            </Button>
          )}
          <IconButton label={t('models.close')} icon={<X size={20} />} onClick={onClose} />
        </div>
        {(asking || askFor !== null) && (
          <div className={styles.consent} role="alertdialog" aria-label={t('civitai.consentTitle')}>
            <strong>{t('civitai.consentTitle')}</strong>
            <p>{t('civitai.consentBody')}</p>
            <div className={styles.consentActions}>
              <Button variant="primary" autoFocus onClick={() => void startUpdate()}>{t('civitai.consentAllow')}</Button>
              <Button onClick={() => { setAsking(false); setAskFor(null) }}>{t('civitai.consentNo')}</Button>
            </div>
          </div>
        )}
        {!civitai.running && civitai.total > 0 && (
          <p className={styles.result}>{t('civitai.result', { found: civitai.found, total: civitai.total })}</p>
        )}
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
          <Select label={t('models.sort')} value={sort} options={SORTS.map((value) => ({ value, label: t(`models.sort.${value}`) }))}
            onChange={(value) => setSort(value as Sort)} />
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
                    {cardStat(item, sort) && <span className={styles.chip}>{cardStat(item, sort)}</span>}
                    {item.civitai?.newer && <span className={`${styles.chip} ${styles.chipWarn}`}>{t('models.newer')}</span>}
                    {item.duplicates.length > 0 && <span className={`${styles.chip} ${styles.chipWarn}`}>{t('models.duplicate', { n: item.duplicates.length + 1 })}</span>}
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
            onTriggers={(triggers) => void setTriggers(kind, current.id, triggers)}
            onOpenCivitai={() => void openOnCivitai(kind, current.id)}
            onInsertWord={insertWord}
            onOpenNewer={() => void openOnCivitai(kind, current.id, 'newer')}
            updateResult={oneResult?.id === current.id ? oneResult.result : null}
            onUpdateOne={() => (consent ? void runOne({ kind, id: current.id }) : setAskFor({ kind, id: current.id }))}
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
  onOpenCivitai(): void
  onInsertWord(word: string): void
  onOpenNewer(): void
  onUpdateOne(): void
  updateResult: string | null
}

function Details({ kind, item, primary, note, onPrimary, onFavorite, onNote, onFamily, onTriggers, onOpenCivitai, onInsertWord, onOpenNewer, onUpdateOne, updateResult }: DetailsProps) {
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
      {(
        <section className={styles.field}>
          <span className={styles.label}>{t('models.triggers')}</span>
          {item.triggers.length === 0 ? (
            <span className={styles.hint}>{t('models.triggersNone')}</span>
          ) : (
            <ul className={styles.words}>
              {item.triggers.map((trigger) => (
                <li key={trigger} className={styles.word}>
                  <button type="button" className={styles.wordText} title={t('lora.insertTrigger', { word: trigger })}
                    aria-label={t('lora.insertTrigger', { word: trigger })} onClick={() => onInsertWord(trigger)}>{trigger}</button>
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
      <div className={styles.field}>
        <span className={styles.label}>{t('civitai.on')}</span>
        {item.civitai && <span className={styles.hint}>{item.civitai.name}{item.civitai.baseModel ? ` · ${item.civitai.baseModel}` : ''}</span>}
        <div className={styles.detailActions}>
          {item.civitai && <Button onClick={onOpenCivitai}>{t('civitai.open')}</Button>}
          <Button disabled={!item.hash || updateResult === 'running'} onClick={onUpdateOne}>{t('civitai.updateOne')}</Button>
        </div>
        {updateResult && updateResult !== 'running' && <span role="status" className={styles.hint}>{t(`civitai.one.${updateResult}` as MessageKey)}</span>}
        {!item.hash && <span className={styles.hint}>{t('civitai.one.noHash')}</span>}
      </div>
      {item.civitai?.newer && (
        <div className={styles.field}>
          <span className={styles.label}>{t('models.newerTitle')}</span>
          <span className={styles.hint}>{item.civitai.newer.name}{item.civitai.newer.publishedAt ? ` · ${day.format(item.civitai.newer.publishedAt)}` : ''}</span>
          <div className={styles.detailActions}><Button onClick={onOpenNewer}>{t('models.openNewer')}</Button></div>
        </div>
      )}
      {item.duplicates.length > 0 && (
        <div className={styles.field}>
          <span className={styles.label}>{t('models.duplicatesTitle')}</span>
          <ul className={styles.copies}>
            {item.duplicates.map((copy) => <li key={copy} className="mono" title={copy}>{copy}</li>)}
          </ul>
        </div>
      )}
      <dl className={styles.facts}>
        <dt>{t('models.path')}</dt>
        <dd className="mono" title={item.id}>{item.id}</dd>
        {item.hash && (<><dt>{t('models.hash')}</dt><dd className="mono">{item.hash.slice(0, 16)}</dd></>)}
      </dl>
    </div>
  )
}
