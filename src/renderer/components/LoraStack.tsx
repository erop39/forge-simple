import { Plus, Warning, X } from '@phosphor-icons/react'
import { PROFILES } from '@shared/profiles'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Slider } from './ui/Slider'
import styles from './LoraStack.module.css'

/** The LoRA of this generation: switch, weight, trigger words, and the gallery to add more. */
export function LoraStack() {
  const params = useAppStore((s) => s.params)
  const catalog = useAppStore((s) => s.catalog)
  const setParams = useAppStore((s) => s.setParams)
  const openModelGallery = useAppStore((s) => s.openModelGallery)
  if (!params) return null
  const loras = params.loras
  const change = (name: string, patch: Partial<(typeof loras)[number]>): void =>
    setParams({ loras: loras.map((l) => (l.name === name ? { ...l, ...patch } : l)) })
  const insert = (word: string): void => {
    const prompt = params.prompt.trimEnd()
    if (new RegExp(`(^|,\\s*)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*,|$)`).test(prompt)) return
    setParams({ prompt: prompt === '' ? word : `${prompt}, ${word}` })
  }

  return (
    <section className={styles.section}>
      <div className={styles.head}>
        <h3 className={styles.heading}>{t('lora.title')}</h3>
        <Button icon={<Plus size={16} />} onClick={() => openModelGallery('lora')}>{t('lora.add')}</Button>
      </div>
      {loras.length === 0 && <p className={styles.empty}>{t('lora.empty')}</p>}
      <ul className={styles.list}>
        {loras.map((lora) => {
          const info = catalog?.loras.find((l) => l.name === lora.name)
          const missing = catalog !== null && !info
          const otherFamily = info?.baseFamily && info.baseFamily !== params.family ? info.baseFamily : null
          const label = info?.alias || lora.name
          return (
            <li key={lora.name} className={styles.item}>
              <div className={styles.row}>
                <input
                  type="checkbox"
                  className={styles.check}
                  aria-label={t('lora.enabled', { name: label })}
                  checked={lora.enabled}
                  onChange={(event) => change(lora.name, { enabled: event.target.checked })}
                />
                <span className={styles.name} title={info?.path ?? lora.name}>{label}</span>
                <IconButton label={t('lora.remove', { name: label })} icon={<X size={16} />}
                  onClick={() => setParams({ loras: loras.filter((l) => l.name !== lora.name) })} />
              </div>
              <Slider label={t('lora.weight', { name: label })} value={lora.weight} min={-2} max={2} step={0.05}
                onCommit={(weight) => change(lora.name, { weight: Math.round(weight * 100) / 100 })} />
              {(missing || (otherFamily && PROFILES[params.family])) && (
                <p className={styles.warn}>
                  <Warning size={14} aria-hidden="true" />
                  {missing ? t('lora.missing') : t('lora.otherFamily', { family: t(`family.${otherFamily!}`) })}
                </p>
              )}
              {info?.triggers && info.triggers.length > 0 && (
                <ul className={styles.words}>
                  {info.triggers.map((word) => (
                    <li key={word}>
                      <button type="button" className={styles.word} title={t('lora.insertTrigger', { word })}
                        aria-label={t('lora.insertTrigger', { word })} onClick={() => insert(word)}>{word}</button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
