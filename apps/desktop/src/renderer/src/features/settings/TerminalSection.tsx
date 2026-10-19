import { useRef, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { Select, Button } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import {
  terminalProfile,
  removeTerminalProfile,
  refreshTerminals,
  terminalSetDefault,
  terminalSetEncoding,
  useTerminalStore,
} from '@/features/terminal/store'
import { SectionTitle, SettingRow } from './SettingRow'
import { useSettings } from './SettingsProvider'
import type { TerminalEncoding, TerminalProfile } from '../../../../shared/types/terminal'
import { isDemo } from '@/data'
import { translateMessage } from '@/i18n/core'
import { useMachines } from '@/features/machines/store'
import { useUnsavedCheck } from './unsavedEdits'

export function TerminalSection() {
  const machines = useMachines()
  const { t } = useI18n(),
    state = useTerminalStore(),
    settings = useSettings()
  const [editing, setEditing] = useState<{ id?: string; label: string; command: string; args: string } | null>(null)
  const [confirm, setConfirm] = useState<string | 'reset' | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<unknown>, done?: () => void): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      done?.()
    } catch (cause) {
      setError(translateMessage(cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setBusy(false)
    }
  }
  // 打开编辑时的样子：改过再取消 / Esc / 点背景要先问（ConfirmDialog 的 dirty）
  const origin = useRef('')
  useUnsavedCheck(() => editing !== null && JSON.stringify(editing) !== origin.current)
  const edit = (p?: TerminalProfile): void => {
    setError(null)
    const next = p
      ? { id: p.id, label: p.label, command: p.command, args: JSON.stringify(p.args) }
      : { label: '', command: '', args: '[]' }
    origin.current = JSON.stringify(next)
    setEditing(next)
  }
  const save = (): void => {
    if (!editing) return
    void run(
      async () => {
        let args: unknown
        try {
          args = JSON.parse(editing.args)
        } catch {
          throw new Error(t('terminal.profileArgsError'))
        }
        if (!Array.isArray(args) || args.some(a => typeof a !== 'string'))
          throw new Error(t('terminal.profileArgsError'))
        await terminalProfile({ ...editing, args })
      },
      () => setEditing(null),
    )
  }
  if (machines.currentId !== 'local')
    return (
      <section>
        <SectionTitle>{t('terminal.settings')}</SectionTitle>
        <p className="text-ui text-fg-muted">{t('SSH_SHELL_MANAGED_REMOTELY')}</p>
      </section>
    )
  return (
    <section>
      <div className="flex items-start justify-between">
        <SectionTitle>{t('terminal.settings')}</SectionTitle>
        <Button icon={RefreshCw} disabled={busy} onClick={() => void run(() => refreshTerminals(true))}>
          {t('terminal.detect')}
        </Button>
      </div>
      {error && !editing && !confirm && (
        <p role="alert" className="mb-4 text-meta text-danger">
          {error}
        </p>
      )}
      <SettingRow title={t('terminal.defaultShell')} description={t('terminal.directoryHint')}>
        <Select
          label={t('terminal.defaultShell')}
          value={state.defaultProfileId}
          fitContent
          options={state.profiles.map(p => ({
            value: p.id,
            label: p.label,
            disabled: !p.available,
            description: p.available ? undefined : t('terminal.notDetected'),
          }))}
          disabled={busy}
          onChange={id => void run(() => terminalSetDefault(id))}
        />
      </SettingRow>
      {state.encoding && (
        <SettingRow title={t('terminal.encoding')} description={t('terminal.encodingHint')}>
          <Select<TerminalEncoding>
            label={t('terminal.encoding')}
            value={state.encoding}
            fitContent
            options={[
              { value: 'utf8', label: t('terminal.encodingUtf8') },
              { value: 'system', label: t('terminal.encodingSystem'), description: t('terminal.encodingSystemHint') },
            ]}
            disabled={busy}
            onChange={encoding => void run(() => terminalSetEncoding(encoding))}
          />
        </SettingRow>
      )}
      <div className="space-y-2">
        {state.profiles.map(p => (
          <div key={p.id} className="rounded-md border border-line px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-ui font-medium">{p.label}</span>
              {!p.available && <span className="text-label text-warn">{t('terminal.unavailable')}</span>}
              {p.custom && (
                <>
                  <button disabled={busy} onClick={() => edit(p)} className="text-meta text-accent-fg">
                    {t('terminal.edit')}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setConfirm(p.id)
                      setError(null)
                    }}
                    className="text-meta text-danger"
                  >
                    {t('terminal.remove')}
                  </button>
                </>
              )}
            </div>
            <p title={p.command} className="mt-1 truncate font-mono text-meta text-fg-muted">
              {p.command} {p.args.join(' ')}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button icon={Plus} disabled={busy} onClick={() => edit()}>
          {t('terminal.custom')}
        </Button>
        <Button disabled={busy} onClick={() => setConfirm('reset')}>
          {t('terminal.reset')}
        </Button>
        <Button onClick={() => settings.openSettings('appearance')}>{t('terminal.fonts')}</Button>
      </div>
      {editing && (
        <ConfirmDialog
          title={t('terminal.custom')}
          confirmLabel={t('terminal.save')}
          cancelLabel={t('terminal.cancel')}
          busy={busy}
          error={error}
          focusInput
          dirty={JSON.stringify(editing) !== origin.current}
          onConfirm={save}
          onCancel={() => setEditing(null)}
          description={
            <div className="space-y-3">
              {(['label', 'command', 'args'] as const).map(field => (
                <label key={field} className="block text-meta">
                  {t(
                    field === 'label'
                      ? 'terminal.profileName'
                      : field === 'command'
                        ? 'terminal.profileCommand'
                        : 'terminal.profileArgs',
                  )}
                  <input
                    value={editing[field]}
                    onChange={e => setEditing({ ...editing, [field]: e.target.value })}
                    className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-2 text-ui text-fg outline-none focus:border-accent"
                  />
                </label>
              ))}
              {!isDemo && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const path = await window.pixelsky!.terminal.chooseProgram()
                      if (path) setEditing(v => (v ? { ...v, command: path } : v))
                    })
                  }
                >
                  {t('terminal.profileChoose')}
                </Button>
              )}
            </div>
          }
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={t(confirm === 'reset' ? 'terminal.reset' : 'terminal.remove')}
          description={t('terminal.resetHint')}
          confirmLabel={t('terminal.remove')}
          cancelLabel={t('terminal.cancel')}
          busy={busy}
          error={error}
          danger
          onConfirm={() =>
            void run(
              () => removeTerminalProfile(confirm === 'reset' ? undefined : confirm),
              () => setConfirm(null),
            )
          }
          onCancel={() => setConfirm(null)}
        />
      )}
    </section>
  )
}
