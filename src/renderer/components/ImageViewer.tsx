import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeft, ArrowRight, Check, Copy, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { PROFILES } from '@shared/profiles'
import type { ImageDetails, ImageRecord } from '@shared/types'
import { baseName, fullTime } from '../format'
import { errorText } from '../i18n/error-text'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import styles from './ImageViewer.module.css'

type Props = {
  image: ImageRecord | null
  opener: RefObject<HTMLButtonElement | null>
  onClose(): void
  onPrevious(): void
  onNext(): void
  hasPrevious: boolean
  hasNext: boolean
  position: number
  loadedCount: number
}

/** Full-size local image with settings read from the persisted job, including after a restart. */
export function ImageViewer({ image, opener, onClose, onPrevious, onNext, hasPrevious, hasNext, position, loadedCount }: Props) {
  const attachImageSource = useAppStore((s) => s.attachImageSource)
  const [details, setDetails] = useState<ImageDetails | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const id = image?.id
  // The image on screen now: a copy that settles after navigation or close must not mark another image.
  const shownId = useRef(id)
  shownId.current = id

  useEffect(() => {
    if (id === undefined) return
    let cancelled = false
    setCopyState('idle')
    window.api.images.details(id).then(
      (value) => { if (!cancelled) { setDetails(value); setLoadError(null) } },
      (error: unknown) => { if (!cancelled) { setDetails(null); setLoadError(errorText(error)) } },
    )
    return () => { cancelled = true }
  }, [id])

  useEffect(() => {
    if (id === undefined) return
    const onArrow = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft' && hasPrevious) {
        event.preventDefault()
        onPrevious()
      } else if (event.key === 'ArrowRight' && hasNext) {
        event.preventDefault()
        onNext()
      }
    }
    document.addEventListener('keydown', onArrow)
    return () => document.removeEventListener('keydown', onArrow)
  }, [id, hasPrevious, hasNext, onPrevious, onNext])

  if (image === null) return null
  const current = details?.image.id === image.id ? details : null
  const params = current?.params
  const profile = params ? PROFILES[params.family] : null
  const hires = params?.hires?.scale && params.hires.scale > 1 ? params.hires : null
  const metadata = params ? [
    [t('params.model'), baseName(params.checkpoint)],
    [t('params.scheduler'), params.scheduler],
    [t('params.sampler'), params.sampler],
    [t('prompt.steps'), String(params.steps)],
    [t('params.size'), `${image.width} × ${image.height}`],
    [t('params.seed'), String(image.seed)],
    ...(profile?.cfg ? [[t('params.cfg'), String(params.cfgScale)]] : []),
    ...(profile?.distilledCfg ? [[t('params.distilledCfg'), String(params.distilledCfg)]] : []),
    ...(profile?.shift && params.shift !== null ? [[t('params.shift'), String(params.shift)]] : []),
    ...(profile?.clipSkip && params.clipSkip !== null ? [[t('params.clipSkip'), String(params.clipSkip)]] : []),
    ...(hires ? [
      [t('params.hires'), hires.scale === 1.5 ? t('params.hires15') : hires.scale === 2 ? t('params.hires2') : t('params.hires4')],
      [t('params.hiresUpscaler'), hires.upscaler],
      [t('params.hiresSteps'), String(hires.secondPassSteps)],
      [t('params.hiresDenoising'), String(hires.denoisingStrength)],
    ] : []),
    ...(image.durationMs === null ? [] : [[t('viewer.time'), t('viewer.seconds', { n: Math.round(image.durationMs / 1000) })]]),
    [t('viewer.created'), fullTime(image.createdAt)],
    ...(params.loras.filter((lora) => lora.enabled).length > 0
      ? [[t('viewer.loras'), params.loras.filter((lora) => lora.enabled).map((lora) => `${baseName(lora.name)} (${lora.weight})`).join(', ')]]
      : []),
  ] : []

  async function copyPrompt(): Promise<void> {
    if (!params) return
    const copiedId = id
    let state: 'copied' | 'failed'
    try {
      await window.api.clipboard.writeText(params.prompt)
      state = 'copied'
    } catch {
      state = 'failed'
    }
    if (shownId.current === copiedId) setCopyState(state)
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            opener.current?.focus()
          }}
        >
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>{t('viewer.title', { n: image.id })}</Dialog.Title>
            <Dialog.Description className="sr-only">{t('viewer.description')}</Dialog.Description>
            <div className={styles.actions}>
              <span className={`mono ${styles.position}`}>{t('viewer.position', { current: position, total: loadedCount })}</span>
              <button type="button" className={styles.iconButton} aria-label={t('viewer.previous')} title={t('viewer.previous')} disabled={!hasPrevious} onClick={onPrevious}>
                <ArrowLeft size={20} aria-hidden="true" />
              </button>
              <button type="button" className={styles.iconButton} aria-label={t('viewer.next')} title={t('viewer.next')} disabled={!hasNext} onClick={onNext}>
                <ArrowRight size={20} aria-hidden="true" />
              </button>
              <button type="button" className={styles.iconButton} aria-label={t('viewer.close')} title={t('viewer.close')} onClick={onClose}>
                <X size={20} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className={styles.stage}>
            <img className={styles.image} src={image.url} alt={t('viewer.imageAlt', { n: image.id })} />
          </div>
          <div className={styles.details}>
            {params ? (
              <>
                <div className={styles.promptHead}>
                  <span className={styles.label}>{t('viewer.prompt')}</span>
                  <div className={styles.promptActions}>
                    <Button onClick={() => { if (attachImageSource(image.id)) onClose() }}>{t('img2img.send')}</Button>
                    <Button icon={copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />} onClick={() => void copyPrompt()}>
                      {copyState === 'copied' ? t('viewer.copied') : t('viewer.copyPrompt')}
                    </Button>
                  </div>
                </div>
                <p className={styles.prompt}>{params.prompt}</p>
                {params.negativePrompt && (
                  <p className={styles.negative}>
                    <span className={styles.label}>{t('viewer.negativePrompt')}: </span>{params.negativePrompt}
                  </p>
                )}
                {copyState === 'failed' && <p role="alert" className={styles.error}>{t('viewer.copyFailed')}</p>}
                <dl className={styles.metadata}>
                  {metadata.map(([label, value]) => (
                    <div className={styles.fact} key={label}>
                      <dt>{label}</dt>
                      <dd className="mono" title={value}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <p className={styles.state} role={loadError ? 'alert' : 'status'}>{loadError ?? t('viewer.loading')}</p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
