import { Shuffle, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { PROFILES } from '@shared/profiles'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { ModelCard, baseName } from './ModelCard'
import { IconButton } from './ui/IconButton'
import { NumberField } from './ui/NumberField'
import { ParamRow } from './ui/ParamRow'
import { Select } from './ui/Select'
import { Tooltip } from './ui/Tooltip'
import { PARAMS_PANEL_ID, PARAMS_TOGGLE_ID } from './params-ids'
import styles from './ParamsPanel.module.css'

/** Matches --dur-panel-out: how long the panel stays mounted while it slides out. */
const SLIDE_OUT_MS = 160
const MAX_SEED = 4294967295

const options = (values: string[]) => values.map((value) => ({ value, label: value }))

function SeedField() {
  const seed = useAppStore((s) => s.params?.seed ?? -1)
  const setParams = useAppStore((s) => s.setParams)
  const [draft, setDraft] = useState<string | null>(null)

  function edit(text: string): void {
    setDraft(text)
    const trimmed = text.trim()
    if (trimmed === '') setParams({ seed: -1 })
    else if (/^\d+$/.test(trimmed) && Number(trimmed) <= MAX_SEED) setParams({ seed: Number(trimmed) })
  }

  return (
    <>
      <input
        className={`mono ${styles.seed}`}
        aria-label={t('params.seed')}
        value={draft ?? (seed === -1 ? t('params.seedRandom') : String(seed))}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        onFocus={(e) => e.target.select()}
        onChange={(e) => edit(e.target.value)}
        onBlur={() => setDraft(null)}
      />
      <IconButton
        label={t('params.seedReset')}
        icon={<Shuffle size={16} />}
        onClick={() => {
          setDraft(null)
          setParams({ seed: -1 })
        }}
      />
    </>
  )
}

function Modules() {
  const modules = useAppStore((s) => s.params?.modules ?? [])
  const available = useAppStore((s) => s.catalog?.modules ?? [])
  const setParams = useAppStore((s) => s.setParams)
  const addable = available.filter((m) => !modules.includes(m.filename))
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{t('params.modules')}</h3>
      {modules.map((module) => (
        <div key={module} className={styles.module}>
          <Tooltip text={module}>
            <span tabIndex={0} className={`mono ${styles.moduleName}`}>
              {baseName(module)}
            </span>
          </Tooltip>
          <IconButton
            label={t('params.removeModule', { name: baseName(module) })}
            icon={<X size={16} />}
            onClick={() => setParams({ modules: modules.filter((m) => m !== module) })}
          />
        </div>
      ))}
      {addable.length > 0 && (
        <div>
          <Select
            label={t('params.addModule')}
            value=""
            options={addable.map((m) => ({ value: m.filename, label: m.name }))}
            onChange={(filename) => setParams({ modules: [...modules, filename] })}
          />
        </div>
      )}
    </section>
  )
}

function Body() {
  const params = useAppStore((s) => s.params)
  const catalog = useAppStore((s) => s.catalog)
  const setParams = useAppStore((s) => s.setParams)
  if (!params || !catalog) return null
  const profile = PROFILES[params.family]
  return (
    <>
      <ModelCard />
      <section className={styles.section}>
        <h3 className={styles.heading}>{t('params.sampling')}</h3>
        <ParamRow label={t('params.sampler')}>
          <Select
            showLabel={false}
            label={t('params.sampler')}
            value={params.sampler}
            options={options(catalog.samplers)}
            onChange={(sampler) => setParams({ sampler })}
          />
        </ParamRow>
        <ParamRow label={t('params.scheduler')}>
          <Select
            showLabel={false}
            label={t('params.scheduler')}
            value={params.scheduler}
            options={options(catalog.schedulers)}
            onChange={(scheduler) => setParams({ scheduler })}
          />
        </ParamRow>
        {profile.cfg && (
          <ParamRow label={t('params.cfg')}>
            <NumberField
              label={t('params.cfg')}
              value={params.cfgScale}
              min={1}
              max={30}
              step={0.5}
              integer={false}
              onCommit={(cfgScale) => setParams({ cfgScale })}
            />
          </ParamRow>
        )}
        {profile.distilledCfg && (
          <ParamRow label={t('params.distilledCfg')}>
            <NumberField
              label={t('params.distilledCfg')}
              value={params.distilledCfg}
              min={0}
              max={30}
              step={0.5}
              integer={false}
              onCommit={(distilledCfg) => setParams({ distilledCfg })}
            />
          </ParamRow>
        )}
        {profile.shift && params.shift !== null && (
          <ParamRow label={t('params.shift')}>
            <NumberField
              label={t('params.shift')}
              value={params.shift}
              min={0}
              max={20}
              step={0.5}
              integer={false}
              onCommit={(shift) => setParams({ shift })}
            />
          </ParamRow>
        )}
        {profile.clipSkip && (
          <ParamRow label={t('params.clipSkip')}>
            <NumberField
              label={t('params.clipSkip')}
              value={params.clipSkip ?? 1}
              min={1}
              max={12}
              onCommit={(clipSkip) => setParams({ clipSkip })}
            />
          </ParamRow>
        )}
        <ParamRow label={t('params.seed')}>
          <SeedField />
        </ParamRow>
        <ParamRow label={t('params.size')}>
          <NumberField
            label={t('params.width')}
            value={params.width}
            min={64}
            max={4096}
            multipleOf={8}
            step={8}
            onCommit={(width) => setParams({ width })}
          />
          <span className={styles.by} aria-hidden="true">
            {t('params.sizeBy')}
          </span>
          <NumberField
            label={t('params.height')}
            value={params.height}
            min={64}
            max={4096}
            multipleOf={8}
            step={8}
            onCommit={(height) => setParams({ height })}
          />
        </ParamRow>
      </section>
      <Modules />
    </>
  )
}

/** Slides in from the right over the canvas; stays mounted only while open or sliding out. */
export function ParamsPanel() {
  const open = useAppStore((s) => s.panelOpen)
  const hasParams = useAppStore((s) => s.params !== null)
  const togglePanel = useAppStore((s) => s.togglePanel)
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    const timer = setTimeout(() => setMounted(false), SLIDE_OUT_MS)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      togglePanel()
      document.getElementById(PARAMS_TOGGLE_ID)?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, togglePanel])

  function close(): void {
    togglePanel()
    document.getElementById(PARAMS_TOGGLE_ID)?.focus()
  }

  if (!hasParams || (!open && !mounted)) return null
  return (
    <aside
      id={PARAMS_PANEL_ID}
      aria-label={t('prompt.allParams')}
      className={`${styles.panel} ${open ? styles.opening : styles.closing}`}
    >
      <header className={styles.head}>
        <h2 className={styles.title}>{t('prompt.allParams')}</h2>
        <IconButton label={t('params.close')} icon={<X size={16} />} onClick={close} />
      </header>
      <div className={styles.scroll}>
        <Body />
      </div>
    </aside>
  )
}
