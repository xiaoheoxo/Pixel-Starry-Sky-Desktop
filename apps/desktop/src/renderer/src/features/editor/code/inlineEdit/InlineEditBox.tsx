// 行内改写的输入框（docs/ui/coding-tier2.md §6）：挂在 CodeMirror 块级 widget 里（createPortal 进会话的 host）。
// 通道、模型跟设置里的 AI 通道走（和 AI 写提交信息、优化提示词同一套），框里只显示通道名，点了去设置
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { EditorView } from '@codemirror/view'
import { Sparkles } from 'lucide-react'
import type { AiCommitResult, AiProblem } from '../../../../../../shared/types/ai'
import { INLINE_EDIT_INSTRUCTION_LIMIT } from '../../../../../../shared/types/ai'
import { isDemo } from '@/data'
import { tr } from '@/i18n/core'
import { cn, Kbd, Spinner, useToast } from '@/ui'
import { isMac } from '@/features/layout/keybindings'
import { channelRequest, problemText } from '@/features/panel/git/AiCommit'
import { fenceLanguage } from '@/features/session/quote'
import { effectiveSource, useAiCommitSettings } from '@/features/settings/aiCommit'
import { useCommitChannels } from '@/features/settings/models/useCommitChannels'
import { useSettings } from '@/features/settings/SettingsProvider'
import {
  applyInline,
  inlineSession,
  keepAll,
  pendingHunks,
  setInlineRunning,
  undoAll,
  watchInline,
  type InlineSession,
} from './extension'
import { changeSummary, contextAround, demoResult, inlineTooLarge } from './model'

const MOD = isMac ? '⌘' : 'Ctrl+'

/** 这个编辑器当前的行内改写会话；没有时不渲染 */
export function InlineEdit({ view, path }: { view: EditorView; path: string }) {
  const session = useSyncExternalStore(
    cb => watchInline(view, cb),
    () => inlineSession(view.state),
  )
  if (!session) return null
  return createPortal(<Box key={session.id} view={view} session={session} path={path} />, session.host)
}

function Box({ view, session, path }: { view: EditorView; session: InlineSession; path: string }) {
  const toast = useToast()
  const settings = useSettings()
  const { model } = useAiCommitSettings()
  const channels = useCommitChannels()
  const source = effectiveSource(model, channels.ctx)
  const [text, setText] = useState('')
  // 正在等的那次记在会话里：切走标签输入框卸载了请求照跑，回来还显示在等；停了、收起了就清掉，晚到的结果不认
  const running = session.running
  const latest = useRef(running)
  latest.current = running
  const mine = (id: string): boolean => inlineSession(view.state)?.running === id
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  // 打开时、结果换进去后把焦点放回输入框，Enter / Ctrl+Enter / Esc 都在这里按
  useEffect(() => input.current?.focus(), [session.applied, session.elapsed])
  const id = session.id
  useEffect(
    () => () => {
      // 会话收起了（不是切标签）才取消
      if (latest.current && inlineSession(view.state)?.id !== id) void window.pixelsky?.ai.cancel(latest.current)
    },
    [view, id],
  )

  const stop = (): void => {
    if (running) void window.pixelsky?.ai.cancel(running)
    if (inlineSession(view.state)?.running) setInlineRunning(view, null)
  }

  const submit = async (): Promise<void> => {
    const said = text.trim()
    const api = window.pixelsky?.ai
    const s = inlineSession(view.state)
    if (running || !said || !s || (!api && !isDemo)) return
    // 继续追问：在上一次的结果（这一段现在的内容）上再改
    const code = view.state.sliceDoc(s.from, s.to)
    if (inlineTooLarge(code)) return setError(tr('editor.inline.tooLarge'))
    const context = contextAround(view.state.doc, s)
    const requestId = crypto.randomUUID()
    setInlineRunning(view, requestId)
    setError(null)
    const started = Date.now()
    let name = model.model
    const fail = (problem: AiProblem, detail: string): void =>
      setError(
        tr('editor.inline.failed', {
          text: problemText({ problem, detail, model: name, source }, channels.name(source)),
        }),
      )
    try {
      let result: AiCommitResult
      if (isDemo || !api) {
        // 演示模式不调模型：固定的示例结果
        await new Promise(r => setTimeout(r, 600))
        result = {
          ok: true,
          message: demoResult(code, tr('editor.inline.demoNote')),
          model: '',
          groupId: null,
          usage: null,
          partial: 0,
          chargeable: false,
        }
      } else {
        const channel = await channelRequest(source, model, channels)
        if (!mine(requestId)) return
        if ('problem' in channel) return fail(channel.problem, channel.detail)
        name = channel.request.model
        result = await api.inlineEdit({
          requestId,
          ...channel.request,
          path,
          language: fenceLanguage(path),
          ...context,
          code,
          instruction: said.slice(0, INLINE_EDIT_INSTRUCTION_LIMIT),
        })
      }
      if (!mine(requestId)) return
      if (!result.ok) {
        if (result.problem !== 'cancelled') fail(result.problem, result.detail)
        return
      }
      const now = inlineSession(view.state)
      // 等的时候这段被改了（或收起又开了别的）：结果作废
      if (!now || now.id !== s.id || view.state.sliceDoc(now.from, now.to) !== code) {
        toast(tr('editor.inline.stale'))
        return
      }
      if (result.message === code) return setError(tr('editor.inline.unchanged'))
      applyInline(view, now, result.message, Date.now() - started)
      setText('')
    } catch (e) {
      if (mine(requestId)) fail('failed', (e as Error)?.message ?? '')
    } finally {
      if (mine(requestId)) setInlineRunning(view, null)
    }
  }

  const done = (keep: boolean): void => {
    stop()
    const s = inlineSession(view.state)
    if (s) {
      if (keep) keepAll(view)
      else undoAll(view, s)
    }
    view.focus()
  }

  const doc = view.state.doc
  const from = doc.lineAt(session.from).number,
    to = doc.lineAt(session.to).number
  const summary = changeSummary(pendingHunks(view.state, session))
  const via = `${channels.name(source)} · ${channels.modelLabel(source, model)}`
  const button = (label: string, run: () => void, primary = false) => (
    <button
      type="button"
      onClick={run}
      className={cn(
        'press inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-meta',
        primary
          ? 'bg-primary text-primary-fg hover:opacity-90'
          : 'border border-line bg-surface text-fg hover:bg-hover',
      )}
    >
      {label}
    </button>
  )

  return (
    <div
      data-inline-edit
      className="flex cursor-auto flex-col gap-1.5 whitespace-normal rounded-lg border border-accent-line bg-popover px-2.5 py-1.5 font-sans text-ui text-fg shadow-popover"
    >
      <div className="flex min-w-0 items-center gap-2">
        {running ? (
          <Spinner size={14} className="shrink-0 text-accent-fg" mono />
        ) : (
          <Sparkles
            size={14}
            strokeWidth={1.5}
            className={cn('shrink-0', session.applied ? 'text-success' : 'text-accent-fg')}
          />
        )}
        <input
          ref={input}
          value={text}
          maxLength={INLINE_EDIT_INSTRUCTION_LIMIT}
          readOnly={!!running}
          aria-label={tr('editor.inline.input')}
          placeholder={tr(
            running
              ? 'editor.inline.running'
              : session.applied
                ? 'editor.inline.followUp'
                : 'editor.inline.placeholder',
          )}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              if (session.applied) done(true)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              if (running) stop()
              else done(false)
            }
          }}
          className="h-6 min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-faint"
        />
        {running && button(tr('editor.inline.stop'), stop)}
        {session.applied && !running && (
          <>
            {button(`${tr('editor.inline.keepAll')} ${MOD}Enter`, () => done(true), true)}
            {button(`${tr('editor.inline.undoAll')} Esc`, () => done(false))}
          </>
        )}
        <button
          type="button"
          title={tr('editor.inline.channelHint')}
          onClick={() => settings.openSettings('assist')}
          className="max-w-[40%] shrink-0 truncate rounded-full bg-subtle px-2 text-meta text-fg-secondary hover:bg-hover hover:text-fg"
        >
          {via}
        </button>
      </div>
      {error && (
        <p role="alert" className="min-w-0 break-words text-meta text-danger">
          {error}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 text-meta text-fg-faint">
        {session.applied ? (
          <>
            <span>
              {tr('editor.inline.summary', { n: summary.count, removed: summary.removed, added: summary.added })}
            </span>
            {session.elapsed !== null && (
              <span>{tr('editor.inline.elapsed', { s: (session.elapsed / 1000).toFixed(1) })}</span>
            )}
            <span className="ml-auto">{tr('editor.inline.draftNote')}</span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd>
              {tr('editor.inline.hintSubmit')}
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Esc</Kbd>
              {tr(running ? 'editor.inline.stop' : 'editor.inline.hintCancel')}
            </span>
            <span className="ml-auto">
              {from === to ? tr('editor.inline.scopeLine', { line: from }) : tr('editor.inline.scope', { from, to })}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
