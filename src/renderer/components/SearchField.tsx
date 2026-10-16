import { MagnifyingGlass, X } from '@phosphor-icons/react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import styles from './SearchField.module.css'

const editable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/** Search of the gallery in the top bar: free text plus tag chips (all tags must match); `/` focuses it. */
export function SearchField({ className }: { className?: string }) {
  const query = useAppStore((s) => s.query)
  const setQuery = useAppStore((s) => s.setQuery)
  const clearQuery = useAppStore((s) => s.clearQuery)
  const suggestTags = useAppStore((s) => s.suggestTags)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [focused, setFocused] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [active, setActive] = useState(-1)

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || editable(event.target)) return
      event.preventDefault()
      input.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const text = query.text
  useEffect(() => {
    const prefix = text.trim()
    if (!focused || prefix === '') { setSuggestions([]); return undefined }
    let live = true
    const timer = setTimeout(() => {
      void suggestTags(prefix).then((names) => {
        if (!live) return
        setSuggestions(names.filter((name) => !query.tags.some((tag) => tag.toLowerCase() === name.toLowerCase())))
        setActive(-1)
      })
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [text, focused, query.tags, suggestTags])

  function addTag(name: string): void {
    setQuery({ tags: [...query.tags, name], text: '' })
    setSuggestions([])
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault()
      setActive((i) => (i + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault()
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (event.key === 'Enter' && active >= 0 && suggestions[active]) {
      event.preventDefault()
      addTag(suggestions[active]!)
    } else if (event.key === 'Backspace' && text === '' && query.tags.length > 0) {
      setQuery({ tags: query.tags.slice(0, -1) })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (text !== '') setQuery({ text: '' })
      else if (query.tags.length > 0) clearQuery()
      else input.current?.blur()
    }
  }

  return (
    <div className={`${styles.field} ${className ?? ''}`} role="search">
      <MagnifyingGlass size={16} aria-hidden="true" className={styles.icon} />
      {query.tags.map((tag) => (
        <span key={tag} className={styles.chip}>
          {tag}
          <button type="button" className={styles.chipRemove} aria-label={t('search.removeTag', { tag })}
            onClick={() => setQuery({ tags: query.tags.filter((x) => x !== tag) })}>
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={input}
        className={styles.input}
        type="text"
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        value={text}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setQuery({ text: event.target.value })}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onKeyDown={onKeyDown}
      />
      {text === '' && query.tags.length === 0 && !focused && <kbd className={`mono ${styles.key}`} aria-hidden="true">/</kbd>}
      {suggestions.length > 0 && (
        <ul id={listId} role="listbox" className={styles.list} aria-label={t('search.suggestions')}>
          {suggestions.map((name, index) => (
            <li key={name} role="option" aria-selected={index === active} className={styles.option}
              data-active={index === active}
              onMouseDown={(event) => { event.preventDefault(); addTag(name) }}>
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
