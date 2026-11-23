import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
// 设置 › 快捷键（docs/ui/custom-shortcuts.md）：点组合键录制新的，Esc 取消；冲突和不允许的组合不保存
import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button, IconButton, Kbd, cn } from '@/ui'
import { bindingFromEvent, bindingProblem } from '@/features/layout/keybindingModel'
import {
  ACTIONS,
  FIXED,
  anyCustomized,
  conflictOf,
  isCustomized,
  isMac,
  labelOf,
  resetAllBindings,
  setBinding,
  setRecording,
  useKeybindings,
  type ActionId,
} from '@/features/layout/keybindings'
import { SectionTitle, SettingGroup } from './SettingRow'

const ROW =
  'relative flex min-h-11 items-center gap-2 px-5 py-1.5 text-ui text-fg first:[&>.shortcut-row-divider]:hidden'
const ROW_DIVIDER = 'shortcut-row-divider pointer-events-none absolute top-0 right-5 left-5 h-px bg-line-subtle/55'
const KEYS = 'rounded-sm border border-line bg-subtle px-1.5 py-0.5 text-fg-secondary'

export function ShortcutsSettings() {
  useI18n()
  useKeybindings()
  const [recording, setRecordingId] = useState<ActionId | null>(null)
  const [error, setError] = useState<{ id: ActionId; text: string } | null>(null)

  // 录制：在最外层先拿到按键，不让它触发别的动作，也不让 Esc 关掉设置
  useEffect(() => {
    if (!recording) return
    setRecording(true)
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setRecordingId(null)
        return
      }
      const binding = bindingFromEvent(e, isMac)
      if (!binding) return
      const problem = bindingProblem(binding)
      const conflict = problem ? null : conflictOf(recording, binding)
      if (problem || conflict) {
        setError({
          id: recording,
          text:
            problem === 'modifier'
              ? tr('settings.shortcuts.needsModifier')
              : problem === 'reserved'
                ? tr('settings.shortcuts.reserved')
                : tr('settings.shortcuts.conflict', { name: conflict! }),
        })
        return
      }
      setBinding(recording, binding)
      setError(null)
      setRecordingId(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      setRecording(false)
    }
  }, [recording])

  const start = (id: ActionId): void => {
    setError(null)
    setRecordingId(current => (current === id ? null : id))
  }

  return (
    <section>
      <SectionTitle>{tr('settings.searchIndex.shortcuts')}</SectionTitle>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-meta text-fg-muted">{tr('settings.shortcuts.hint')}</p>
        <Button
          variant="outline"
          icon={RotateCcw}
          className="h-8 px-3 text-meta"
          disabled={!anyCustomized()}
          onClick={() => {
            resetAllBindings()
            setError(null)
            setRecordingId(null)
          }}
        >
          {tr('settings.shortcuts.resetAll')}
        </Button>
      </div>
      <ul className="overflow-hidden rounded-xl bg-surface shadow-sm">
        {ACTIONS.map(action => {
          const active = recording === action.id
          const rowError = error?.id === action.id ? error.text : null
          return (
            <li key={action.id} className={cn(ROW, 'flex-wrap')} data-shortcut={action.id}>
              <span aria-hidden className={ROW_DIVIDER} />
              <span className="min-w-0 flex-1">{tr(action.label)}</span>
              {isCustomized(action.id) && !active && (
                <IconButton
                  icon={RotateCcw}
                  label={tr('settings.shortcuts.reset')}
                  size={26}
                  iconSize={13}
                  onClick={() => setBinding(action.id, null)}
                />
              )}
              <button
                type="button"
                aria-pressed={active}
                aria-label={tr('settings.shortcuts.edit', { name: tr(action.label) })}
                onClick={() => start(action.id)}
                onBlur={() => active && setRecordingId(null)}
                className={cn(
                  'press min-w-24 rounded-md border px-2 py-1 text-center font-mono text-label tracking-wide',
                  active
                    ? 'border-accent bg-accent-soft text-accent-fg'
                    : isCustomized(action.id)
                      ? 'border-line-strong bg-subtle text-fg hover:border-fg-faint'
                      : 'border-line bg-subtle text-fg-secondary hover:border-line-strong',
                )}
              >
                {active ? tr('settings.shortcuts.recording') : labelOf(action.id)}
              </button>
              {rowError && (
                <p role="status" className="basis-full pb-1 text-right text-meta text-danger">
                  {rowError}
                </p>
              )}
            </li>
          )
        })}
      </ul>
      <SettingGroup
        title={tr('settings.shortcuts.fixed')}
        description={tr('settings.shortcuts.fixedHint')}
        className="mt-6"
      >
        <ul>
          {FIXED.map(item => (
            <li key={item.label} className={ROW}>
              <span aria-hidden className={ROW_DIVIDER} />
              <span className="min-w-0 flex-1">{tr(item.label)}</span>
              <Kbd className={KEYS}>{item.keys()}</Kbd>
            </li>
          ))}
        </ul>
      </SettingGroup>
    </section>
  )
}
