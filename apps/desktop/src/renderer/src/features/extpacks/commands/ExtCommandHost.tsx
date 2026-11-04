// 脚本扩展的命令：运行、权限确认、脚本弹的对话框、快捷键（docs/ui/extension-commands-plan.md §4–§6）
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { cn } from '@/ui/cn'
import { useToast } from '@/ui'
import { getLocale, tr, type TranslationKey } from '@/i18n/core'
import { ACTIONS, FIXED, bindingOf, isMac } from '@/features/layout/keybindings'
import { matchesBinding } from '@/features/layout/keybindingModel'
import { focusedEditorTab, getEditorView } from '@/features/editor/code/CodeEditor'
import type { ExtCommandApiCall, ExtCommandFailure } from '../../../../../shared/types/ext-commands'
import { getPackState, subscribePacks } from '../store'
import { editorCall, type EditorRun } from './editorApi'
import {
  activeBindings,
  commandBlock,
  packCommands,
  PERMISSION_TEXT,
  type EditorSnapshot,
  type PackCommand,
} from './model'

const FAILURE: Record<ExtCommandFailure, TranslationKey> = {
  timeout: 'extCommands.failed.timeout',
  memory: 'extCommands.failed.memory',
  crashed: 'extCommands.failed.crashed',
  loadFailed: 'extCommands.failed.loadFailed',
  thrown: 'extCommands.failed.thrown',
  badCall: 'extCommands.failed.badCall',
  busy: 'extCommands.failed.busy',
  unavailable: 'extCommands.failed.unavailable',
  stopped: 'extCommands.failed.stopped',
}
/** 现在能运行命令的编辑器：最后获得焦点、还在页面上的那个 */
export function editorSnapshot(tabId: string | null = focusedEditorTab()): EditorSnapshot {
  const view = tabId ? getEditorView(tabId) : null
  return { hasEditor: !!view, hasSelection: !!view && !view.state.selection.main.empty }
}

type Dialog =
  | { kind: 'consent'; command: PackCommand; permissions: string[]; tabId: string | null }
  | {
      kind: 'pick'
      token: string
      packName: string
      title: string
      items: string[]
      answer: (v: string | null) => void
    }
  | { kind: 'input'; token: string; packName: string; title: string; value: string; answer: (v: string | null) => void }

interface Run extends EditorRun {
  packName: string
}
const runs = new Map<string, Run>()
const bridge = (): NonNullable<typeof window.pixelsky>['extCommands'] | undefined => window.pixelsky?.extCommands
let setDialogOutside: ((d: Dialog | null) => void) | null = null
let toastOutside: ((m: string) => void) | null = null
let tokenSeq = 0

/** 运行一条命令；tabId 是右键菜单明确给的，不给就用最后获得焦点的编辑器 */
export async function runPackCommand(command: PackCommand, tabId: string | null = focusedEditorTab()): Promise<void> {
  const api = bridge()
  if (!api) return
  const token = `t${Date.now()}-${++tokenSeq}`
  runs.set(token, { tabId, doc: tabId ? (getEditorView(tabId)?.state.doc ?? null) : null, packName: command.packName })
  try {
    const outcome = await api.run(command.packKey, command.id, token)
    if (outcome.status === 'needsConsent')
      setDialogOutside?.({ kind: 'consent', command, permissions: outcome.permissions, tabId })
    else if (outcome.status === 'failed')
      toastOutside?.(tr(FAILURE[outcome.code], { name: command.packName, detail: outcome.detail ?? '' }))
  } catch (e) {
    toastOutside?.(tr('extCommands.failed.thrown', { name: command.packName, detail: (e as Error).message }))
  } finally {
    runs.delete(token)
    // 命令面板、确认框、脚本的对话框关掉后焦点落在 body 上，Ctrl+Z 就到不了编辑器。别的地方有焦点时不抢
    const view = tabId ? getEditorView(tabId) : null
    if (view && (document.activeElement === document.body || document.activeElement === null)) view.focus()
  }
}

export function ExtCommandHost() {
  const toast = useToast()
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [draft, setDraft] = useState('')
  const [picked, setPicked] = useState(0)
  setDialogOutside = setDialog
  toastOutside = toast

  // 脚本的调用：编辑器直接做，对话框等用户回答
  useEffect(() => {
    const api = bridge()
    if (!api) return
    const offApi = api.onApi((call: ExtCommandApiCall) => {
      const run = runs.get(call.token)
      const reply = (r: Parameters<typeof api.apiReply>[1]): void => void api.apiReply(call.callId, r)
      if (!run) return reply({ ok: false, message: 'the command has ended' })
      try {
        if (call.method === 'ui.showMessage') {
          toast(tr('extCommands.message', { name: run.packName, text: call.args[0] as string }))
          return reply({ ok: true })
        }
        if (call.method === 'ui.pick' || call.method === 'ui.input') {
          const answer = (value: string | null): void => {
            setDialog(null)
            reply({ ok: true, value })
          }
          const title = call.args[call.method === 'ui.pick' ? 1 : 0] as string
          if (call.method === 'ui.pick') {
            setPicked(0)
            setDialog({
              kind: 'pick',
              token: call.token,
              packName: run.packName,
              title,
              items: call.args[0] as string[],
              answer,
            })
          } else {
            setDraft(call.args[1] as string)
            setDialog({
              kind: 'input',
              token: call.token,
              packName: run.packName,
              title,
              value: call.args[1] as string,
              answer,
            })
          }
          return
        }
        reply({ ok: true, value: editorCall(run, call.method, call.args) })
      } catch (e) {
        reply({ ok: false, message: (e as Error).message })
      }
    })
    // 脚本超时、被停掉时收起它的对话框
    const offFinished = api.onFinished(token =>
      setDialog(d => (d && d.kind !== 'consent' && d.token === token ? null : d)),
    )
    return () => {
      offApi()
      offFinished()
    }
  }, [toast])

  // 快捷键。冒泡阶段：编辑器、终端自己处理过的（defaultPrevented）不抢；终端输入也不抢
  useEffect(() => {
    let bound: PackCommand[] = []
    const refresh = (): void => {
      const taken = [...ACTIONS.map(a => bindingOf(a.id)), ...FIXED.flatMap(f => f.bindings)]
      bound = activeBindings(packCommands(getPackState(), getLocale()), taken)
    }
    refresh()
    const off = subscribePacks(refresh)
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat || (e.target as Element | null)?.closest?.('.xterm')) return
      const command = bound.find(c => matchesBinding(e, c.binding!, isMac))
      if (!command || commandBlock(command, editorSnapshot())) return
      e.preventDefault()
      void runPackCommand(command)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  if (!dialog) return null
  if (dialog.kind === 'consent')
    return (
      <ConfirmDialog
        title={tr('extCommands.consent.title', { name: dialog.command.packName })}
        description={
          <div data-ext-consent>
            <p>{tr('extCommands.consent.body')}</p>
            <ul className="mt-2 list-disc pl-5">
              {dialog.permissions.map(p => (
                <li key={p}>{PERMISSION_TEXT[p] ? tr(PERMISSION_TEXT[p]) : p}</li>
              ))}
            </ul>
          </div>
        }
        confirmLabel={tr('extCommands.consent.allow')}
        cancelLabel={tr('extCommands.cancel')}
        busy={false}
        warn
        onConfirm={() => {
          const { command, permissions, tabId } = dialog
          setDialog(null)
          void bridge()
            ?.grant(command.packKey, permissions)
            .then(() => runPackCommand(command, tabId))
        }}
        onCancel={() => setDialog(null)}
      />
    )
  if (dialog.kind === 'pick')
    return (
      <ConfirmDialog
        title={dialog.title || dialog.packName}
        description={
          <div data-ext-pick>
            <p className="mb-2 text-meta text-fg-faint">{tr('extCommands.from', { name: dialog.packName })}</p>
            <ul className="max-h-64 overflow-y-auto">
              {dialog.items.map((item, i) => (
                <li key={i}>
                  <button
                    type="button"
                    aria-pressed={i === picked}
                    className={cn(
                      'w-full truncate rounded px-2 py-1 text-left text-ui hover:bg-hover',
                      i === picked && 'bg-selected',
                    )}
                    onClick={() => setPicked(i)}
                    onDoubleClick={() => dialog.answer(item)}
                  >
                    {item}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        }
        confirmLabel={tr('extCommands.ok')}
        cancelLabel={tr('extCommands.cancel')}
        busy={false}
        onConfirm={() => dialog.answer(dialog.items[picked] ?? null)}
        onCancel={() => dialog.answer(null)}
      />
    )
  return (
    <ConfirmDialog
      title={dialog.title || dialog.packName}
      description={
        <div data-ext-input>
          <p className="mb-2 text-meta text-fg-faint">{tr('extCommands.from', { name: dialog.packName })}</p>
          <input
            className="w-full rounded border border-line-card bg-surface px-2 py-1 text-ui"
            value={draft}
            maxLength={500}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') dialog.answer(draft)
            }}
          />
        </div>
      }
      confirmLabel={tr('extCommands.ok')}
      cancelLabel={tr('extCommands.cancel')}
      busy={false}
      focusInput
      onConfirm={() => dialog.answer(draft)}
      onCancel={() => dialog.answer(null)}
    />
  )
}
