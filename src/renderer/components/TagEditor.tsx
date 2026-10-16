import { X } from '@phosphor-icons/react'
import { useEffect, useId, useState, type KeyboardEvent, type Ref } from 'react'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import styles from './TagEditor.module.css'

type TagEditorProps = {
  tags: string[]
  /** Called with the whole new list after an add or a removal. */
  onChange(tags: string[]): void
  label: string
  placeholder?: string
  inputRef?: Ref<HTMLInputElement>
}

const sameTag = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** Tags as chips with an input: Enter or a comma adds, Backspace in the empty input removes the last, × removes one. */
export function TagEditor({ tags, onChange, label, placeholder, inputRef }: TagEditorProps) {
  const suggestTags = useAppStore((s) => s.suggestTags)
  const listId = useId()
  const [text, setText] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [active, setActive] = useState(-1)

  useEffect(() => {
    const prefix = text.trim()
    if (prefix === '') { setSuggestions([]); return undefined }
    let live = true
    const timer = setTimeout(() => {
      void suggestTags(prefix).then((names) => {
        if (!live) return
        setSuggestions(names.filter((name) => !tags.some((tag) => sameTag(tag, name))))
        setActive(-1)
      })
    }, 150)
    return () => { live = false; clearTimeout(timer) }
  }, [text, tags, suggestTags])

  function add(raw: string): void {
    const name = raw.trim().replace(/\s+/g, ' ')
    setText('')
    setSuggestions([])
    if (name === '' || name.length > 40 || tags.some((tag) => sameTag(tag, name))) return
    onChange([...tags, name])
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      add(active >= 0 && suggestions[active] ? suggestions[active]! : text)
    } else if (event.key === 'Backspace' && text === '' && tags.length > 0) {
      onChange(tags.slice(0, -1))
    } else if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault()
      setActive((i) => (i + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault()
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (event.key === 'Escape' && (text !== '' || suggestions.length > 0)) {
      event.stopPropagation()
      setText('')
      setSuggestions([])
    }
  }

  return (
    <div className={styles.editor}>
      {tags.map((tag) => (
        <span key={tag} className={styles.tag}>
          {tag}
          <button type="button" className={styles.remove} aria-label={t('tags.remove', { tag })}
            onClick={() => onChange(tags.filter((x) => x !== tag))}>
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={tags.length === 0 ? placeholder ?? t('tags.add') : t('tags.add')}
        value={text}
        maxLength={40}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setText(event.target.value.replace(/,/g, ''))}
        onKeyDown={onKeyDown}
        onBlur={() => { if (text.trim() !== '') add(text) }}
      />
      {suggestions.length > 0 && (
        <ul id={listId} role="listbox" className={styles.list} aria-label={t('search.suggestions')}>
          {suggestions.map((name, index) => (
            <li key={name} role="option" aria-selected={index === active} data-active={index === active}
              className={styles.option} onMouseDown={(event) => { event.preventDefault(); add(name) }}>
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
