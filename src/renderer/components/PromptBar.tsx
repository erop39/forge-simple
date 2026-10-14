import { ArrowUp, SlidersHorizontal } from '@phosphor-icons/react'
import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { PROFILES, RATIOS, dimsForRatio } from '@shared/profiles'
import type { GenerationParams } from '@shared/types'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { NumberField } from './ui/NumberField'
import { Select } from './ui/Select'
import { PARAMS_PANEL_ID, PARAMS_TOGGLE_ID } from './params-ids'
import styles from './PromptBar.module.css'

const LAST_PROMPT_KEY = 'fnc.lastPrompt'
const CUSTOM_RATIO = 'custom'
/** Set on the document root so the gallery can leave room under the floating bar. */
const BAR_HEIGHT_VAR = '--prompt-bar-h'

function readLastPrompt(): string {
  try {
    return localStorage.getItem(LAST_PROMPT_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeLastPrompt(prompt: string): void {
  try {
    localStorage.setItem(LAST_PROMPT_KEY, prompt)
  } catch {
    // Storage can be unavailable; the history is a convenience only.
  }
}

const ratioValue = (ratio: readonly [number, number]): string => `${ratio[0]}:${ratio[1]}`

/** The ratio whose dimensions at the profile's default area equal the current size, or the custom marker. */
function currentRatio(params: GenerationParams, area: number): string {
  const match = RATIOS.find((ratio) => {
    const dims = dimsForRatio(ratio, area)
    return dims.width === params.width && dims.height === params.height
  })
  return match ? ratioValue(match) : CUSTOM_RATIO
}

type GrowingFieldProps = {
  id?: string
  value: string
  label: string
  placeholder: string
  className?: string
  onChange(value: string): void
  onKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): void
}

/** A textarea that grows with its content; CSS caps the height at six lines and then it scrolls. */
function GrowingField({ id, value, label, placeholder, className, onChange, onKeyDown }: GrowingFieldProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    // scrollHeight leaves out the border, which the border-box height must include.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      id={id}
      rows={1}
      className={className}
      value={value}
      aria-label={label}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  )
}

export function PromptBar() {
  const params = useAppStore((s) => s.params)
  const catalog = useAppStore((s) => s.catalog)
  const panelOpen = useAppStore((s) => s.panelOpen)
  const setParams = useAppStore((s) => s.setParams)
  const selectCheckpoint = useAppStore((s) => s.selectCheckpoint)
  const generate = useAppStore((s) => s.generate)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const [negativeOpen, setNegativeOpen] = useState(false)
  const negativeId = useId()
  const observer = useRef<ResizeObserver | null>(null)
  const publishHeight = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    const root = document.documentElement.style
    if (!el) {
      root.removeProperty(BAR_HEIGHT_VAR)
      return
    }
    const apply = () => root.setProperty(BAR_HEIGHT_VAR, `${el.offsetHeight}px`)
    apply()
    observer.current = new ResizeObserver(apply)
    observer.current.observe(el)
  }, [])

  if (!params || !catalog) return null
  const profile = PROFILES[params.family]
  const blank = params.prompt.trim() === ''
  const area = profile.defaults.width * profile.defaults.height
  const ratio = currentRatio(params, area)

  function submit(): void {
    if (!params || blank) return
    writeLastPrompt(params.prompt)
    void generate()
  }

  function onPromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      submit()
    } else if (event.key === 'ArrowUp' && params?.prompt === '') {
      const last = readLastPrompt()
      if (last !== '') {
        event.preventDefault()
        setParams({ prompt: last })
      }
    }
  }

  const ratioOptions = RATIOS.map((r) => ({ value: ratioValue(r), label: ratioValue(r) }))
  if (ratio === CUSTOM_RATIO) ratioOptions.push({ value: CUSTOM_RATIO, label: t('prompt.ratioCustom') })

  return (
    <div ref={publishHeight} className={`${styles.bar} ${panelOpen ? styles.shifted : ''}`}>
      {profile.negative && negativeOpen && (
        <GrowingField
          id={negativeId}
          className={`${styles.field} ${styles.negativeField}`}
          value={params.negativePrompt}
          label={t('prompt.negative')}
          placeholder={t('prompt.negativePlaceholder')}
          onChange={(negativePrompt) => setParams({ negativePrompt })}
        />
      )}
      <GrowingField
        className={styles.field}
        value={params.prompt}
        label={t('prompt.placeholder')}
        placeholder={t('prompt.placeholder')}
        onChange={(prompt) => setParams({ prompt })}
        onKeyDown={onPromptKeyDown}
      />
      <div className={styles.row}>
        <Select
          label={t('params.model')}
          value={params.checkpoint}
          options={catalog.checkpoints.map((c) => ({ value: c.title, label: c.name }))}
          onChange={(title) => void selectCheckpoint(title)}
        />
        <Select
          label={t('prompt.ratio')}
          value={ratio}
          options={ratioOptions}
          onChange={(value) => {
            const picked = RATIOS.find((r) => ratioValue(r) === value)
            if (picked) setParams(dimsForRatio(picked, area))
          }}
        />
        <NumberField
          inline
          label={t('prompt.steps')}
          value={params.steps}
          min={1}
          max={200}
          onCommit={(steps) => setParams({ steps })}
        />
        <NumberField
          inline
          label={t('prompt.images')}
          value={params.count}
          min={1}
          max={8}
          onCommit={(count) => setParams({ count })}
        />
        {profile.negative && (
          <Button
            aria-expanded={negativeOpen}
            aria-controls={negativeOpen ? negativeId : undefined}
            onClick={() => setNegativeOpen((open) => !open)}
          >
            {t('prompt.negative')}
          </Button>
        )}
        <span className={styles.spacer} />
        <IconButton
          id={PARAMS_TOGGLE_ID}
          label={t('prompt.allParams')}
          icon={<SlidersHorizontal size={20} />}
          aria-expanded={panelOpen}
          aria-controls={PARAMS_PANEL_ID}
          onClick={togglePanel}
        />
        <Button
          variant="primary"
          className={styles.generate}
          aria-label={t('prompt.generate')}
          aria-disabled={blank}
          icon={<ArrowUp size={16} />}
          onClick={submit}
        />
      </div>
    </div>
  )
}
