import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import type { GenerationParams, HiresSettings } from '@shared/types'
import { PROFILES, hiresUpscaler } from '@shared/profiles'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { NumberField } from './ui/NumberField'
import { ParamRow } from './ui/ParamRow'
import { Select } from './ui/Select'
import { Slider } from './ui/Slider'
import styles from './HiresDialog.module.css'

const SCALES = [1.5, 2, 4] as const
const options = (values: string[]) => values.map((value) => ({ value, label: value }))

/**
 * Send to hires: the saved image's own job (model, prompt, seed) runs again with a second pass at a larger size,
 * as Forge's Hires. fix does. The settings are chosen here and never touch the prompt bar.
 */
export function HiresDialog() {
  const id = useAppStore((s) => s.hiresFor)
  const close = useAppStore((s) => s.closeHires)
  return (
    <Dialog.Root open={id !== null} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content} aria-describedby={undefined}>
          <Dialog.Title className={styles.title}>{t('hires.title')}</Dialog.Title>
          {id !== null && <HiresForm key={id} id={id} onClose={close} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function HiresForm({ id, onClose }: { id: number; onClose: () => void }) {
  const upscalers = useAppStore((s) => s.catalog?.upscalers ?? [])
  const preferred = useAppStore((s) => s.settings?.upscalers?.hires)
  const queueHires = useAppStore((s) => s.queueHires)
  const [source, setSource] = useState<GenerationParams | 'notTxt2img' | 'failed' | null>(null)
  const [hires, setHires] = useState<HiresSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true
    window.api.images.details(id).then((details) => {
      if (!current) return
      if (details.jobType !== 'txt2img') { setSource('notTxt2img'); return }
      const upscaler = [preferred, details.params.hires?.upscaler].find((name) => name && upscalers.includes(name))
        ?? hiresUpscaler(upscalers)
      const scale = SCALES.find((value) => details.params.width * value <= 4096 && details.params.height * value <= 4096)
      setSource(details.params)
      setHires({ scale: scale ?? 1.5, upscaler, secondPassSteps: details.params.hires?.secondPassSteps ?? 12,
        denoisingStrength: details.params.hires?.denoisingStrength ?? 0.4,
        cfgScale: details.params.hires?.cfgScale ?? details.params.cfgScale })
    }).catch(() => { if (current) setSource('failed') })
    return () => { current = false }
  }, [id, preferred, upscalers])

  if (source === null || hires === null && typeof source !== 'string') {
    return <p className={styles.note} role="status">{t('viewer.loading')}</p>
  }
  if (typeof source === 'string') {
    return (
      <>
        <p className={styles.note} role="alert">{t(source === 'notTxt2img' ? 'hires.notTxt2img' : 'hires.failed')}</p>
        <div className={styles.actions}><Button autoFocus onClick={onClose}>{t('hires.cancel')}</Button></div>
      </>
    )
  }
  const settings = hires!
  const profile = PROFILES[source.family]
  const scales = SCALES.filter((value) => source.width * value <= 4096 && source.height * value <= 4096)
  const change = (patch: Partial<HiresSettings>): void => setHires({ ...settings, ...patch })

  async function send(): Promise<void> {
    if (busy) return
    setBusy(true)
    setFailed(false)
    const outcome = await queueHires(id, settings)
    setBusy(false)
    if (outcome === 'queued') onClose()
    else setFailed(true)
  }

  return (
    <>
      <p className={`mono ${styles.target}`}>
        {t('params.hiresTarget', {
          width: source.width, height: source.height,
          targetWidth: Math.round(source.width * settings.scale), targetHeight: Math.round(source.height * settings.scale),
        })}
      </p>
      <ParamRow label={t('params.hiresScale')}>
        <Select showLabel={false} label={t('params.hiresScale')} value={String(settings.scale)}
          options={scales.map((value) => ({ value: String(value), label: `${value}×` }))}
          onChange={(value) => change({ scale: Number(value) as HiresSettings['scale'] })} />
      </ParamRow>
      <ParamRow label={t('params.hiresUpscaler')}>
        <Select showLabel={false} label={t('params.hiresUpscaler')} value={settings.upscaler}
          options={options(upscalers.filter((name) => name !== 'None').length ? upscalers.filter((name) => name !== 'None') : [settings.upscaler])}
          onChange={(upscaler) => change({ upscaler })} />
      </ParamRow>
      <ParamRow label={t('params.hiresSteps')}>
        <NumberField label={t('params.hiresSteps')} value={settings.secondPassSteps} min={1} max={150}
          onCommit={(secondPassSteps) => change({ secondPassSteps })} />
      </ParamRow>
      <ParamRow label={t('params.hiresDenoising')}>
        <Slider label={t('params.hiresDenoising')} value={settings.denoisingStrength} min={0} max={1} step={0.05}
          onCommit={(denoisingStrength) => change({ denoisingStrength })} />
      </ParamRow>
      {(profile.cfg || profile.distilledCfg) && (
        <ParamRow label={t('params.hiresCfg')}>
          <Slider label={t('params.hiresCfg')} value={settings.cfgScale ?? source.cfgScale} min={1} max={30} step={0.5}
            onCommit={(cfgScale) => change({ cfgScale })} />
        </ParamRow>
      )}
      {failed && <p className={styles.error} role="alert">{t('hires.failed')}</p>}
      <div className={styles.actions}>
        <Button onClick={onClose}>{t('hires.cancel')}</Button>
        <Button autoFocus disabled={busy} onClick={() => void send()}>{t('hires.queue')}</Button>
      </div>
    </>
  )
}
