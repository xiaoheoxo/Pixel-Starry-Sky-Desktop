import { translateMessage, tr } from '../../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { useEffect, useState } from 'react'
import { CodeXml, Plus, RefreshCw } from 'lucide-react'
import { Button, Segmented, Switch, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { SectionTitle, SettingGroup, SettingRow } from '../../settings/SettingRow'
import { refreshEditors, setEditors, useEditors } from '@/features/editor/store'
import { isDemo } from '@/data'
import type { EditorKind } from '../../../../../shared/types/workspace'
import { EditorIcon, editorLabel, editorSource } from '@/features/editor/EditorIcon'
import { AutoSaveSetting } from './AutoSaveSetting'
import { GitOpenStyleSettings } from '../../settings/GitOpenStyleSettings'
import { setWordComplete, useWordComplete } from '../code/snippets/words'
import { useUnsavedCheck } from '../../settings/unsavedEdits'

const KNOWN_EXTERNAL_EDITORS: ReadonlyArray<{ kind: Exclude<EditorKind, 'custom'>; label: string }> = [
  { kind: 'vscode', label: 'VS Code' },
  { kind: 'cursor', label: 'Cursor' },
  { kind: 'trae-cn', label: 'Trae CN' },
  { kind: 'trae', label: 'Trae' },
  { kind: 'windsurf', label: 'Windsurf' },
  { kind: 'jetbrains', label: 'JetBrains IDE' },
]

export function EditorSection() {
  useI18n()
  const state = useEditors(),
    wordComplete = useWordComplete(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [customOpen, setCustomOpen] = useState(false),
    [name, setName] = useState(() => tr('settings.editor.EditorSection.customEditor')),
    [mode, setMode] = useState<'folder' | 'code'>('folder')

  useUnsavedCheck(() => customOpen && name.trim() !== tr('settings.editor.EditorSection.customEditor'))

  const run = async (fn: () => Promise<unknown>, onDone?: () => void): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (isDemo) throw new Error(tr('settings.editor.EditorSection.demoModeCannotChange'))
      await fn()
      onDone?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refreshEditors().catch(e => setError(e.message))
  }, [])

  const choose = (kind: EditorKind, onDone?: () => void): void => {
    void run(async () => {
      const result = await window.pixelsky!.editor.choose(kind, name, mode)
      if (result) setEditors(result)
    }, onDone)
  }

  const items = state?.items ?? []
  const missingKnown = KNOWN_EXTERNAL_EDITORS.filter(k => !items.some(i => i.kind === k.kind))

  return (
    <section>
      <SectionTitle>{tr('settings.editor.EditorSection.editor')}</SectionTitle>
      <p className="mb-4 text-meta text-fg-muted">{tr('settings.editor.EditorSection.viewAndEditFiles')}</p>
      {error && (
        <p role="status" className="mb-3 text-meta text-danger">
          {translateMessage(error)}
        </p>
      )}

      <SettingGroup title={tr('settingsLayout.editor.builtIn')}>
        <AutoSaveSetting />
        <SettingRow
          title={tr('editor.complete.title')}
          description={tr('editor.complete.description')}
          control={<Switch checked={wordComplete} label={tr('editor.complete.title')} onChange={setWordComplete} />}
        />
        <GitOpenStyleSettings />
      </SettingGroup>

      <SettingGroup title={tr('settingsLayout.editor.externalPrefs')}>
        <SettingRow
          title={tr('settings.editor.EditorSection.windowMode')}
          description={tr('settings.editor.EditorSection.vsCodeCompatibleEditors')}
          control={
            <Segmented
              label={tr('settings.editor.EditorSection.editorWindowMode')}
              value={state?.window ?? 'reuse'}
              options={[
                {
                  value: 'reuse',
                  get label() {
                    return tr('settings.editor.EditorSection.reuseWindow')
                  },
                },
                {
                  value: 'new',
                  get label() {
                    return tr('settings.editor.EditorSection.newWindow')
                  },
                },
              ]}
              onChange={value =>
                void run(async () => setEditors(await window.pixelsky!.editor.preferences({ window: value })))
              }
            />
          }
        />
      </SettingGroup>

      {/* 四块合一外部编辑器卡：默认选择、路径状态、手动指定路径、添加自定义编辑器集中在一处 */}
      <SettingGroup
        title={tr('settings.editor.EditorSection.defaultExternalEditor')}
        description={tr('settings.editor.EditorSection.editorToolbarsExternalEditor')}
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              icon={RefreshCw}
              className="h-7 px-2.5 text-meta"
              disabled={busy}
              onClick={() => {
                setError('')
                void refreshEditors(true).catch(e => setError(e.message))
              }}
            >
              {tr('session.SourceHintBar.detectAgain')}
            </Button>
            <span data-setting-title={tr('settings.editor.EditorSection.customEditor')}>
              <Button
                icon={Plus}
                className="h-7 px-2.5 text-meta"
                disabled={busy || isDemo}
                onClick={() => {
                  setName(tr('settings.editor.EditorSection.customEditor'))
                  setMode('folder')
                  setCustomOpen(true)
                }}
              >
                {tr('settingsLayout.editor.addCustom')}
              </Button>
            </span>
          </div>
        }
      >
        <div data-setting-title={tr('settings.editor.EditorSection.executablePath')}>
          {items.map(item => {
            const isDefault = state?.defaultId === item.id
            return (
              <div
                key={item.id}
                className={cn(
                  'relative flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 first:[&>.editor-row-divider]:hidden',
                  !item.available && 'opacity-70',
                )}
              >
                <span
                  aria-hidden
                  className="editor-row-divider pointer-events-none absolute top-0 right-5 left-5 h-px bg-line-subtle/55"
                />
                <div className="flex min-w-[12rem] flex-1 items-start gap-3">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-subtle">
                    <EditorIcon item={item} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ui font-medium text-fg">{editorLabel(item)}</span>
                      {isDefault && (
                        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-label font-medium text-accent-fg">
                          {tr('openWith.default')}
                        </span>
                      )}
                      <span className={cn('text-label', item.available ? 'text-fg-faint' : 'text-warn')}>
                        {editorSource(item)} ·{' '}
                        {item.available
                          ? tr('settings.editor.EditorSection.available')
                          : tr('settings.editor.EditorSection.invalidPath')}
                      </span>
                    </div>
                    <p title={item.path} className="mt-0.5 truncate font-mono text-meta text-fg-muted">
                      {item.path}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {item.available && !isDefault && (
                    <Button
                      className="h-7 px-2.5 text-meta"
                      disabled={busy || isDemo}
                      onClick={() =>
                        void run(async () =>
                          setEditors(await window.pixelsky!.editor.preferences({ defaultId: item.id })),
                        )
                      }
                    >
                      {tr('openWith.setDefault')}
                    </Button>
                  )}
                  {item.kind !== 'custom' && (
                    <Button
                      variant="ghost"
                      className="h-7 px-2 text-meta"
                      disabled={busy || isDemo}
                      onClick={() => choose(item.kind)}
                    >
                      {tr('settingsLayout.editor.changePath')}
                    </Button>
                  )}
                  {item.manual && (
                    <Button
                      variant="ghost"
                      className="h-7 px-2 text-meta text-danger hover:text-danger"
                      disabled={busy}
                      onClick={() => void run(async () => setEditors(await window.pixelsky!.editor.remove(item.id)))}
                    >
                      {item.kind === 'custom' || item.kind === 'jetbrains'
                        ? tr('settings.editor.EditorSection.removeConfiguration')
                        : tr('settings.editor.EditorSection.restoreAutomaticDetection')}
                    </Button>
                  )}
                </div>
              </div>
            )
          })}

          {missingKnown.map(entry => (
            <div
              key={entry.kind}
              className="relative flex items-center justify-between gap-3 px-5 py-3 opacity-80 first:[&>.editor-row-divider]:hidden"
            >
              <span
                aria-hidden
                className="editor-row-divider pointer-events-none absolute top-0 right-5 left-5 h-px bg-line-subtle/55"
              />
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle/70 text-fg-faint">
                  <CodeXml size={15} />
                </span>
                <div className="min-w-0">
                  <span className="text-ui text-fg-secondary">{entry.label}</span>
                  <span className="ml-2 text-label text-fg-faint">· {tr('settingsLayout.editor.notDetected')}</span>
                  {entry.kind === 'jetbrains' && (
                    <p className="mt-0.5 text-label text-fg-faint">
                      {tr('settings.editor.EditorSection.jetbrainsHint')}
                    </p>
                  )}
                </div>
              </div>
              <Button
                className="h-7 shrink-0 px-2.5 text-meta"
                disabled={busy || isDemo}
                onClick={() => choose(entry.kind)}
              >
                {tr('settingsLayout.editor.choosePath')}
              </Button>
            </div>
          ))}
        </div>
      </SettingGroup>

      {state?.checkedAt ? (
        <p className="mt-2.5 text-meta text-fg-faint">
          {tr('settings.editor.EditorSection.detectedAt')} {new Date(state.checkedAt).toLocaleTimeString('zh-CN')}
        </p>
      ) : null}

      {customOpen && (
        <ConfirmDialog
          title={tr('settings.editor.EditorSection.customEditor')}
          confirmLabel={tr('settings.editor.EditorSection.chooseExecutableAndAdd')}
          cancelLabel={tr('terminal.cancel')}
          busy={busy}
          error={error ? translateMessage(error) : null}
          focusInput
          dirty={name.trim() !== tr('settings.editor.EditorSection.customEditor')}
          onConfirm={() => {
            if (!name.trim()) return
            choose('custom', () => setCustomOpen(false))
          }}
          onCancel={() => setCustomOpen(false)}
          description={
            <div className="space-y-3">
              <label className="block text-meta text-fg-secondary">
                {tr('settings.editor.EditorSection.name')}
                <input
                  aria-label={tr('settings.editor.EditorSection.customEditorName')}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  maxLength={60}
                  className="mt-1 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-ui text-fg outline-none focus:border-accent"
                />
              </label>
              <div>
                <div className="mb-1.5 text-meta text-fg-secondary">
                  {tr('settings.editor.EditorSection.customEditorOpeningMethod')}
                </div>
                <Segmented
                  label={tr('settings.editor.EditorSection.customEditorOpeningMethod')}
                  value={mode}
                  options={[
                    {
                      value: 'folder',
                      get label() {
                        return tr('settings.editor.EditorSection.folderArgument')
                      },
                    },
                    {
                      value: 'code',
                      get label() {
                        return tr('settings.editor.EditorSection.vsCodeCompatible')
                      },
                    },
                  ]}
                  onChange={setMode}
                />
              </div>
            </div>
          }
        />
      )}
    </section>
  )
}
