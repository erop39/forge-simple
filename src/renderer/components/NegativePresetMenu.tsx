import * as Menu from '@radix-ui/react-dropdown-menu'
import { BookmarkSimple } from '@phosphor-icons/react'
import { useRef, useState } from 'react'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { ManagePresetsDialog, SavePresetDialog } from './NegativePresetDialogs'
import { IconButton } from './ui/IconButton'
import selectStyles from './ui/Select.module.css'
import styles from './NegativePresets.module.css'

/** Distance the menu keeps from the window edges; equals --sp-2 (as in ui/Select). */
const COLLISION_PADDING = 8

type NegativePresetMenuProps = {
  /** The current text of the Negative field. */
  negative: string
  /** Puts a preset's text into the Negative field (replacing it) and shows the field. */
  onApply(text: string): void
}

type Open = 'save' | 'manage' | null

/** The saved negatives next to the Negative toggle: apply one, save the current text, or manage them. */
export function NegativePresetMenu({ negative, onApply }: NegativePresetMenuProps) {
  const presets = useAppStore((s) => s.negativePresets)
  const [open, setOpen] = useState<Open>(null)
  // A dialog opened from the menu keeps the focus: the menu must not hand it back to its trigger.
  const opening = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const openDialog = (which: Exclude<Open, null>) => {
    opening.current = true
    setOpen(which)
  }

  return (
    <>
      <Menu.Root>
        <Menu.Trigger ref={trigger} asChild>
          <IconButton label={t('presets.menu')} icon={<BookmarkSimple size={20} />} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className={selectStyles.content}
            align="end"
            sideOffset={4}
            collisionPadding={COLLISION_PADDING}
            onCloseAutoFocus={(e) => {
              if (opening.current) e.preventDefault()
              opening.current = false
            }}
          >
            {presets.length === 0 ? (
              <p className={styles.menuEmpty}>{t('presets.empty')}</p>
            ) : (
              presets.map((preset) => (
                <Menu.Item
                  key={preset.id}
                  className={`${selectStyles.item} ${styles.menuItem}`}
                  title={preset.text}
                  onSelect={() => onApply(preset.text)}
                >
                  <span className={styles.menuName}>{preset.name}</span>
                </Menu.Item>
              ))
            )}
            <Menu.Separator className={styles.separator} />
            <Menu.Item
              className={`${selectStyles.item} ${styles.menuItem}`}
              disabled={negative.trim() === ''}
              onSelect={() => openDialog('save')}
            >
              {t('presets.saveCurrent')}
            </Menu.Item>
            <Menu.Item className={`${selectStyles.item} ${styles.menuItem}`} onSelect={() => openDialog('manage')}>
              {t('presets.manage')}
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <SavePresetDialog
        open={open === 'save'}
        text={negative}
        returnFocus={trigger}
        onOpenChange={(next) => setOpen(next ? 'save' : null)}
      />
      <ManagePresetsDialog
        open={open === 'manage'}
        returnFocus={trigger}
        onOpenChange={(next) => setOpen(next ? 'manage' : null)}
      />
    </>
  )
}
