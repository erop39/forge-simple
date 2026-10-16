import * as Dialog from '@radix-ui/react-dialog'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { FloppyDisk, PencilSimple, Trash, X } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import type { Preset } from '@shared/types'
import { errorText } from '../i18n/error-text'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import selectStyles from './ui/Select.module.css'
import styles from './PresetMenu.module.css'

type Open = 'save' | 'manage' | null

/** Saved sets of settings next to the model menu: apply one, save the current settings, or manage them. */
export function PresetMenu() {
  const presets = useAppStore((s) => s.presets)
  const applyPreset = useAppStore((s) => s.applyPreset)
  const [open, setOpen] = useState<Open>(null)
  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <IconButton label={t('preset.menu')} icon={<FloppyDisk size={20} />} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className={selectStyles.content} align="start" sideOffset={4} collisionPadding={8}>
            {presets.length === 0 ? (
              <p className={styles.empty}>{t('preset.empty')}</p>
            ) : presets.map((preset) => (
              <Menu.Item key={preset.id} className={selectStyles.item} onSelect={() => applyPreset(preset)}>
                <span className={styles.name}>{preset.name}</span>
              </Menu.Item>
            ))}
            <Menu.Separator className={styles.separator} />
            <Menu.Item className={selectStyles.item} onSelect={() => setOpen('save')}>{t('preset.save')}</Menu.Item>
            <Menu.Item className={selectStyles.item} disabled={presets.length === 0} onSelect={() => setOpen('manage')}>{t('preset.manage')}</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {open === 'save' && <SavePreset onClose={() => setOpen(null)} />}
      {open === 'manage' && <ManagePresets onClose={() => setOpen(null)} />}
    </>
  )
}

function Frame({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} aria-describedby={undefined}>
          <div className={styles.head}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            <Dialog.Close asChild><IconButton label={t('preset.close')} icon={<X size={16} />} /></Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SavePreset({ onClose }: { onClose: () => void }) {
  const savePreset = useAppStore((s) => s.savePreset)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy || name.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      await savePreset(name.trim())
      onClose()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Frame title={t('preset.saveTitle')} onClose={onClose}>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <p className={styles.hint}>{t('preset.saveHint')}</p>
        <label className={styles.field}>
          <span className={styles.label}>{t('preset.name')}</span>
          <input className={styles.input} autoFocus maxLength={80} placeholder={t('preset.namePlaceholder')}
            value={name} onChange={(event) => { setName(event.target.value); setError(null) }} />
        </label>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        <div className={styles.actions}>
          <Button onClick={onClose}>{t('preset.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={busy || name.trim() === ''}>{t('preset.saveConfirm')}</Button>
        </div>
      </form>
    </Frame>
  )
}

function ManagePresets({ onClose }: { onClose: () => void }) {
  const presets = useAppStore((s) => s.presets)
  const renamePreset = useAppStore((s) => s.renamePreset)
  const deletePreset = useAppStore((s) => s.deletePreset)
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function saveName(preset: Preset): Promise<void> {
    if (!renaming || renaming.name.trim() === '') return
    setError(null)
    try {
      await renamePreset(preset.id, renaming.name.trim())
      setRenaming(null)
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <Frame title={t('preset.manageTitle')} onClose={onClose}>
      {presets.length === 0 ? <p className={styles.hint}>{t('preset.empty')}</p> : (
        <ul className={styles.list}>
          {presets.map((preset) => (
            <li key={preset.id} className={styles.row}>
              {renaming?.id === preset.id ? (
                <>
                  <input className={styles.input} autoFocus maxLength={80} aria-label={t('preset.name')} value={renaming.name}
                    onChange={(event) => setRenaming({ id: preset.id, name: event.target.value })}
                    onKeyDown={(event) => { if (event.key === 'Enter') void saveName(preset); if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null) } }} />
                  <Button onClick={() => void saveName(preset)}>{t('preset.renameSave')}</Button>
                </>
              ) : confirming === preset.id ? (
                <>
                  <span className={styles.confirm}>{t('preset.deleteConfirm', { name: preset.name })}</span>
                  <Button onClick={() => setConfirming(null)}>{t('preset.deleteNo')}</Button>
                  <Button variant="danger" onClick={() => { setConfirming(null); void deletePreset(preset.id) }}>{t('preset.deleteYes')}</Button>
                </>
              ) : (
                <>
                  <span className={styles.rowName} title={preset.name}>{preset.name}</span>
                  <IconButton label={t('preset.rename', { name: preset.name })} icon={<PencilSimple size={16} />}
                    onClick={() => { setError(null); setRenaming({ id: preset.id, name: preset.name }) }} />
                  <IconButton label={t('preset.delete', { name: preset.name })} icon={<Trash size={16} />} onClick={() => setConfirming(preset.id)} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </Frame>
  )
}
