import { ArrowUp, SlidersHorizontal, X } from '@phosphor-icons/react'
import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { PROFILES, RATIOS, dimsForRatio } from '@shared/profiles'
import type { GenerationParams } from '@shared/types'
import { t } from '../i18n/t'
import { checkpointOptions } from '../state/checkpoint-options'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { Notice } from './ui/Notice'
import { NegativePresetMenu } from './NegativePresetMenu'
import { IconButton } from './ui/IconButton'
import { NumberField } from './ui/NumberField'
import { Select } from './ui/Select'
import { Slider } from './ui/Slider'
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

/** Shown after repeated Forge 500s: offers the restart, or explains how to allow it. */
function UnhealthyNotice() {
  const unhealthy = useAppStore((s) => s.forgeUnhealthy)
  const canRestart = useAppStore((s) => s.capabilities.canRestart)
  const askRestart = useAppStore((s) => s.askRestart)
  const dismiss = useAppStore((s) => s.dismissUnhealthy)
  if (!unhealthy) return null
  return canRestart ? (
    <Notice text={t('forge.unhealthy')} action={{ label: t('forge.restart'), onClick: askRestart }} onDismiss={dismiss} />
  ) : (
    <Notice text={t('forge.unhealthyNoRestart')} onDismiss={dismiss} />
  )
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
  const draftPrompt = useAppStore((s) => s.draftPrompt)
  const catalog = useAppStore((s) => s.catalog)
  const catalogError = useAppStore((s) => s.catalogError)
  const settings = useAppStore((s) => s.settings)
  const panelOpen = useAppStore((s) => s.panelOpen)
  const logOpen = useAppStore((s) => s.logOpen)
  const setParams = useAppStore((s) => s.setParams)
  const images = useAppStore((s) => s.images)
  const attachImageSource = useAppStore((s) => s.attachImageSource)
  const removeImageSource = useAppStore((s) => s.removeImageSource)
  const selectCheckpoint = useAppStore((s) => s.selectCheckpoint)
  const generate = useAppStore((s) => s.generate)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const [negativeOpen, setNegativeOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
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

  const prompt = params?.prompt ?? draftPrompt
  // The catalog can take time to load, especially its optional LoRA list. The writing field stays
  // usable meanwhile; model-dependent controls appear once the store carries the draft into a model.
  const model = params !== null && catalog !== null ? { params, catalog, profile: PROFILES[params.family] } : null
  const loading = model === null && (settings === null || settings.serverUrl !== null)
    && catalog === null && catalogError === null
  const blank = prompt.trim() === ''
  const source = params?.img2img ? images.find((image) => image.id === params.img2img!.sourceImageId && !image.locked) : null
  const sourceMissing = !!params?.img2img && !source
  const area = model ? model.profile.defaults.width * model.profile.defaults.height : 0
  const ratio = model ? currentRatio(model.params, area) : CUSTOM_RATIO

  function submit(): void {
    if (!model || blank || sourceMissing) return
    writeLastPrompt(model.params.prompt)
    void generate()
  }

  /** Ctrl+Enter submits from either field; true when the key needs no further handling (also while composing). */
  function submitOnCtrlEnter(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (event.nativeEvent.isComposing) return true
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return false
    event.preventDefault()
    submit()
    return true
  }

  function onPromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (submitOnCtrlEnter(event)) return
    if (event.key === 'ArrowUp' && prompt === '') {
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
    <div ref={publishHeight} data-img2img-drop className={`${styles.bar} ${panelOpen || logOpen ? styles.shifted : ''} ${dragOver ? styles.dragOver : ''}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('application/x-forge-neo-image-id')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragOver(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={(event) => {
        setDragOver(false)
        const id = Number(event.dataTransfer.getData('application/x-forge-neo-image-id'))
        if (Number.isSafeInteger(id) && id > 0) {
          event.preventDefault()
          attachImageSource(id)
        }
      }}
    >
      <UnhealthyNotice />
      {dragOver && <p className={styles.dropHint}>{t('img2img.drop')}</p>}
      {params?.img2img && (
        <div className={styles.sourceRow}>
          <span className={`mono ${styles.mode}`}>{t('img2img.mode')}</span>
          {source && <img className={styles.sourceThumb} src={source.thumbUrl} alt={t('img2img.source', { n: source.id })} />}
          <span className={styles.sourceName}>{source ? t('img2img.source', { n: source.id }) : t('img2img.unavailable')}</span>
          <IconButton label={t('img2img.remove')} icon={<X size={16} />} onClick={removeImageSource} />
        </div>
      )}
      {model?.profile.negative && negativeOpen && (
        <GrowingField
          id={negativeId}
          className={`${styles.field} ${styles.negativeField}`}
          value={model.params.negativePrompt}
          label={t('prompt.negative')}
          placeholder={t('prompt.negativePlaceholder')}
          onChange={(negativePrompt) => setParams({ negativePrompt })}
          onKeyDown={submitOnCtrlEnter}
        />
      )}
      <GrowingField
        className={styles.field}
        value={prompt}
        label={t('prompt.placeholder')}
        placeholder={t('prompt.placeholder')}
        onChange={(value) => setParams({ prompt: value })}
        onKeyDown={onPromptKeyDown}
      />
      <div className={styles.row}>
        {model ? (
          <Select
            grow
            label={t('params.model')}
            value={model.params.checkpoint}
            options={checkpointOptions(model.catalog.checkpoints)}
            onChange={(title) => void selectCheckpoint(title)}
          />
        ) : loading && <span role="status" className={styles.pending}>{t('prompt.loadingModels')}</span>}
        <div className={styles.controls}>
          {model && (
            <>
              <Select
                label={t('prompt.ratio')}
                value={ratio}
                options={ratioOptions}
                onChange={(value) => {
                  const picked = RATIOS.find((r) => ratioValue(r) === value)
                  if (picked) setParams(dimsForRatio(picked, area))
                }}
              />
              <Slider
                inline
                label={t('prompt.steps')}
                value={model.params.steps}
                min={1}
                max={150}
                step={1}
                onCommit={(steps) => setParams({ steps })}
              />
              <NumberField
                inline
                label={t('prompt.images')}
                value={model.params.count}
                min={1}
                max={8}
                onCommit={(count) => setParams({ count })}
              />
              {model.profile.negative && (
                <>
                  <Button
                    aria-expanded={negativeOpen}
                    aria-controls={negativeOpen ? negativeId : undefined}
                    onClick={() => setNegativeOpen((open) => !open)}
                  >
                    {t('prompt.negative')}
                  </Button>
                  <NegativePresetMenu
                    negative={model.params.negativePrompt}
                    onApply={(negativePrompt) => {
                      setParams({ negativePrompt })
                      setNegativeOpen(true)
                    }}
                  />
                </>
              )}
              <IconButton
                id={PARAMS_TOGGLE_ID}
                label={t('prompt.allParams')}
                icon={<SlidersHorizontal size={20} />}
                aria-expanded={panelOpen}
                aria-controls={PARAMS_PANEL_ID}
                onClick={togglePanel}
              />
            </>
          )}
          <Button
            variant="primary"
            className={styles.generate}
            aria-label={t('prompt.generate')}
            disabled={model === null}
            aria-disabled={model ? blank || sourceMissing : undefined}
            icon={<ArrowUp size={16} />}
            onClick={submit}
          />
        </div>
      </div>
    </div>
  )
}
