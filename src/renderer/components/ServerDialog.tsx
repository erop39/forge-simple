import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle, PencilSimple, Plus, Trash, X } from '@phosphor-icons/react'
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { ServerInfo } from '@shared/types'
import { errorText } from '../i18n/error-text'
import { t } from '../i18n/t'
import { useAppStore } from '../state/StoreProvider'
import { RestartConfirm } from './ForgeRestart'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import styles from './ServerDialog.module.css'

type ServerDialogProps = { open: boolean; onOpenChange: (open: boolean) => void }

/** Without an active server the dialog cannot be dismissed: the app is unusable without one. */
export function ServerDialog({ open, onOpenChange }: ServerDialogProps) {
  const hasServer = Boolean(useAppStore((s) => s.settings?.serverUrl))
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next || hasServer) && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          onEscapeKeyDown={(e) => !hasServer && e.preventDefault()}
          onInteractOutside={(e) => !hasServer && e.preventDefault()}
        >
          <ServerPanel dismissible={hasServer} onDone={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

type View = { kind: 'list' } | { kind: 'add' } | { kind: 'edit'; server: ServerInfo }

/** The saved servers, or the form to add or edit one. With no saved server it is always the add form. */
function ServerPanel({ dismissible, onDone }: { dismissible: boolean; onDone: () => void }) {
  const servers = useAppStore((s) => s.servers)
  const [view, setView] = useState<View>({ kind: 'list' })
  const toList = () => setView({ kind: 'list' })
  const empty = servers.length === 0

  const head = (
    <div className={styles.head}>
      <Dialog.Title className={styles.title}>{t('server.title')}</Dialog.Title>
      {dismissible && (
        <Dialog.Close asChild>
          <IconButton label={t('server.close')} icon={<X size={16} />} />
        </Dialog.Close>
      )}
    </div>
  )

  if (empty || view.kind === 'add') {
    // The first saved server closes the dialog; a later one returns to the list.
    return <ServerForm head={head} server={null} onSaved={empty ? onDone : toList} onCancel={empty ? null : toList} />
  }
  if (view.kind === 'edit') {
    return <ServerForm head={head} server={view.server} onSaved={toList} onCancel={toList} />
  }
  return (
    <ServerList
      head={head}
      servers={servers}
      onAdd={() => setView({ kind: 'add' })}
      onEdit={(server) => setView({ kind: 'edit', server })}
    />
  )
}

type ServerListProps = {
  head: ReactNode
  servers: ServerInfo[]
  onAdd: () => void
  onEdit: (server: ServerInfo) => void
}

function ServerList({ head, servers, onAdd, onEdit }: ServerListProps) {
  const running = useAppStore((s) => Object.values(s.jobs).some((j) => j.status === 'running'))
  const activateServer = useAppStore((s) => s.activateServer)
  const removeServer = useAppStore((s) => s.removeServer)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyId = useId()

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  return (
    <div className={styles.form}>
      {head}
      <Dialog.Description className={styles.hint}>{t('server.listHint')}</Dialog.Description>
      <ul className={styles.list} aria-label={t('server.list')}>
        {servers.map((server) => (
          <ServerRow
            key={server.id}
            server={server}
            confirming={confirming === server.id}
            locked={running || busy}
            busyId={running ? busyId : undefined}
            onUse={() => void run(() => activateServer(server.id))}
            onEdit={() => onEdit(server)}
            onAskDelete={() => setConfirming(server.id)}
            onKeep={() => setConfirming(null)}
            onDelete={() => {
              setConfirming(null)
              void run(() => removeServer(server.id))
            }}
          />
        ))}
      </ul>
      {running && (
        <p id={busyId} className={styles.hint}>
          {t('server.busy')}
        </p>
      )}
      <ForgeActions running={running} busyId={busyId} />
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        {/* Focus starts here rather than on the close button, whose tooltip would take the first Escape. */}
        <Button autoFocus icon={<Plus size={16} />} onClick={onAdd}>
          {t('server.add')}
        </Button>
      </div>
    </div>
  )
}

/** Unload model and Restart Forge for the active server. Restart asks first and needs --api-server-stop. */
function ForgeActions({ running, busyId }: { running: boolean; busyId: string }) {
  const server = useAppStore((s) => s.servers.find((x) => x.active) ?? null)
  const canRestart = useAppStore((s) => s.capabilities.canRestart)
  const unloadModel = useAppStore((s) => s.unloadModel)
  const [confirming, setConfirming] = useState(false)
  const [unloading, setUnloading] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hintId = useId()
  if (!server) return null
  const heading = t('forge.heading', { name: server.name })

  async function unload(): Promise<void> {
    setUnloading(true)
    setStatus(null)
    setError(null)
    try {
      await unloadModel()
      setStatus(t('forge.unloaded'))
    } catch (e) {
      setError(errorText(e))
    }
    setUnloading(false)
  }

  return (
    <section aria-label={heading} className={styles.forge}>
      <h3 className={styles.forgeHeading}>{heading}</h3>
      {confirming ? (
        <RestartConfirm
          onCancel={() => setConfirming(false)}
          onRestarting={() => {
            setConfirming(false)
            setStatus(t('forge.restartStarted'))
          }}
        />
      ) : (
        <div className={styles.forgeActions}>
          <Button disabled={unloading || running} aria-describedby={running ? busyId : undefined} onClick={() => void unload()}>
            {unloading ? t('forge.unloading') : t('forge.unload')}
          </Button>
          <Button
            disabled={!canRestart}
            aria-describedby={canRestart ? undefined : hintId}
            onClick={() => {
              setStatus(null)
              setError(null)
              setConfirming(true)
            }}
          >
            {t('forge.restart')}
          </Button>
        </div>
      )}
      {!canRestart && (
        <p id={hintId} className={styles.hint}>
          {t('forge.restartHint')}
        </p>
      )}
      {status !== null && (
        <p role="status" className={styles.hint}>
          {status}
        </p>
      )}
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  )
}

type ServerRowProps = {
  server: ServerInfo
  confirming: boolean
  /** A job runs or another server action is in flight: no switching, and the active server cannot go. */
  locked: boolean
  /** Id of the text explaining why Use is disabled, when it is. */
  busyId: string | undefined
  onUse: () => void
  onEdit: () => void
  onAskDelete: () => void
  onKeep: () => void
  onDelete: () => void
}

function ServerRow({ server, confirming, locked, busyId, onUse, onEdit, onAskDelete, onKeep, onDelete }: ServerRowProps) {
  const nameId = useId()
  if (confirming) {
    return (
      <li className={styles.row} aria-labelledby={nameId}>
        <p id={nameId} className={styles.confirmText}>
          {t('server.deleteConfirm', { name: server.name })}
        </p>
        <div className={styles.rowActions}>
          <Button autoFocus onClick={onKeep}>
            {t('server.deleteNo')}
          </Button>
          <Button variant="danger" onClick={onDelete}>
            {t('server.deleteYes')}
          </Button>
        </div>
      </li>
    )
  }
  return (
    <li className={styles.row} aria-labelledby={nameId}>
      <div className={styles.rowText}>
        <span id={nameId} className={styles.name} title={server.name}>
          {server.name}
        </span>
        <span className={`mono ${styles.url}`} title={server.url}>
          {server.url}
        </span>
      </div>
      <div className={styles.rowActions}>
        {server.active ? (
          <span className={styles.active}>
            <CheckCircle size={16} aria-hidden="true" />
            {t('server.active')}
          </span>
        ) : (
          <Button disabled={locked} aria-describedby={busyId} onClick={onUse}>
            {t('server.use')}
          </Button>
        )}
        <IconButton label={t('server.edit', { name: server.name })} icon={<PencilSimple size={16} />} onClick={onEdit} />
        <IconButton
          label={t('server.delete', { name: server.name })}
          icon={<Trash size={16} />}
          disabled={server.active && locked}
          onClick={onAskDelete}
        />
      </div>
    </li>
  )
}

type ServerFormProps = {
  head: ReactNode
  /** The server to edit, or null to add one. */
  server: ServerInfo | null
  onSaved: () => void
  /** Null when there is nothing to go back to. */
  onCancel: (() => void) | null
}

function ServerForm({ head, server, onSaved, onCancel }: ServerFormProps) {
  const addServer = useAppStore((s) => s.addServer)
  const updateServer = useAppStore((s) => s.updateServer)
  const [name, setName] = useState(server?.name ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const errorId = useId()
  const [idle, working] = server ? [t('server.save'), t('server.saving')] : [t('server.connect'), t('server.connecting')]

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy || url.trim() === '') return
    setBusy(true)
    setError(null)
    let ok = false
    const fields = { name: name.trim(), url: url.trim() }
    try {
      const check = await (server ? updateServer(server.id, fields) : addServer(fields))
      ok = check.ok
      if (!ok) setError(errorText(check.errorKey))
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
    if (ok) onSaved()
    else input.current?.focus()
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {head}
      <label className={styles.field}>
        <span className={styles.label}>{t('server.name')}</span>
        <input
          className={styles.input}
          value={name}
          placeholder={t('server.namePlaceholder')}
          readOnly={busy}
          spellCheck={false}
          autoComplete="off"
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>{t('server.address')}</span>
        <input
          ref={input}
          className={`mono ${styles.input}`}
          value={url}
          placeholder={t('server.placeholder')}
          readOnly={busy}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? `${errorId} ${hintId}` : hintId}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {error !== null && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <Dialog.Description className={styles.hint}>
        <span id={hintId}>{t('server.hint')}</span>
      </Dialog.Description>
      <div className={styles.actions}>
        {onCancel && (
          <Button onClick={onCancel} disabled={busy}>
            {t('server.cancel')}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={busy || url.trim() === ''}>
          <span className={styles.stack}>
            <span aria-hidden={busy} className={busy ? styles.hidden : undefined}>
              {idle}
            </span>
            <span aria-hidden={!busy} className={busy ? undefined : styles.hidden}>
              {working}
            </span>
          </span>
        </Button>
      </div>
    </form>
  )
}
