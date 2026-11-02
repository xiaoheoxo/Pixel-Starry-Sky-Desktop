// 优化提示词（docs/ui/prompt-optimize.md）：输入框工具栏的「优化」按钮。把输入框里的话交给 AI 改写，结果直接换进输入框，
// 可以撤回；通道、模型和 AI 写提交信息共用（设置 › 模型）。改写中再打字就停掉这次，免得结果盖掉新写的
import { useEffect, useRef, useState } from 'react'
import { Sparkles, Square } from 'lucide-react'
import type { AiProblem, AiSource } from '../../../../shared/types/ai'
import { cn, Spinner } from '@/ui'
import { tr } from '@/i18n/core'
import { getEngineState } from '@/features/engine/store'
import { effectiveSource, useAiCommitSettings } from '@/features/settings/aiCommit'
import { useCommitChannels } from '@/features/settings/models/useCommitChannels'
import { channelRequest, problemText } from '@/features/panel/git/AiCommit'
import { isSlashCommand } from '@/features/panel/annotationText'
import { promptContext } from './promptContext'

type Note =
  | { kind: 'done'; previous: string; written: string }
  | { kind: 'error'; problem: AiProblem; detail: string; model: string; source: AiSource }

export function usePromptOptimize({
  text,
  setText,
  sessionId,
}: {
  text: string
  setText: (text: string) => void
  sessionId: string | null
}) {
  const { writing, model } = useAiCommitSettings()
  const channels = useCommitChannels()
  const source = effectiveSource(model, channels.ctx)
  const [running, setRunning] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const original = useRef('')
  /** 正在等的那次；停了就清掉，晚到的结果不认 */
  const active = useRef<string | null>(null)
  const current = useRef(text)
  current.current = text
  const live = useRef(true)
  useEffect(
    () => () => {
      live.current = false
    },
    [],
  )

  const stop = () => {
    if (running) void window.pixelsky?.ai.cancel(running)
    active.current = null
    setRunning(null)
  }
  // 改写中又打字：停掉这次；改了写好的字：「撤回」不再显示
  useEffect(() => {
    if (running && text !== original.current) stop()
    if (note?.kind === 'done' && text !== note.written) setNote(null)
    if (note?.kind === 'error' && text !== original.current) setNote(null)
    // 只在输入框的字变了时看：写好时先设 note 再换字，跟着 note 跑会在换字前把它清掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const start = async (): Promise<void> => {
    const api = window.pixelsky?.ai
    const typed = current.current
    if (running || !api || !typed.trim() || isSlashCommand(typed)) return
    const requestId = crypto.randomUUID()
    original.current = typed
    active.current = requestId
    setNote(null)
    setRunning(requestId)
    const fail = (problem: AiProblem, detail: string, name: string) =>
      setNote({ kind: 'error', problem, detail, model: name, source })
    try {
      const channel = await channelRequest(source, model, channels)
      if (active.current !== requestId) return
      if ('problem' in channel) return fail(channel.problem, channel.detail, model.model)
      const snap = sessionId ? getEngineState().snapshots[sessionId] : null
      const result = await api.optimizePrompt({
        requestId,
        ...channel.request,
        text: typed,
        context: promptContext(snap),
      })
      // 停了、又打字了：结果不要了
      if (!live.current || active.current !== requestId || current.current !== typed) return
      if (!result.ok) {
        if (result.problem !== 'cancelled') fail(result.problem, result.detail, channel.request.model)
        return
      }
      setNote({ kind: 'done', previous: typed, written: result.message })
      setText(result.message)
    } catch (e) {
      if (live.current && active.current === requestId) fail('failed', (e as Error)?.message ?? '', model.model)
    } finally {
      if (active.current === requestId) active.current = null
      if (live.current) setRunning(id => (id === requestId ? null : id))
    }
  }

  return {
    enabled: writing.promptButton,
    running: running !== null,
    note,
    via: `${channels.name(source)} · ${channels.modelLabel(source, model)}`,
    channelName: (s: AiSource) => channels.name(s),
    start: () => void start(),
    stop,
    undo: () => {
      if (note?.kind === 'done') setText(note.previous)
      setNote(null)
    },
  }
}

export type PromptOptimizer = ReturnType<typeof usePromptOptimize>

/** 工具栏的按钮：有字时可用（斜杠命令原样发，不改写）；改写中是转圈，悬停变成停止 */
export function PromptOptimizeButton({ po, text }: { po: PromptOptimizer; text: string }) {
  const off = !text.trim() || isSlashCommand(text)
  const label = po.running ? tr('promptOptimize.stop') : tr('promptOptimize.buttonVia', { via: po.via })
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!po.running && off}
      onClick={() => (po.running ? po.stop() : po.start())}
      className={cn(
        'group/po press no-drag inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-ui text-fg-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
        (po.running || !off) && 'text-accent-fg',
      )}
    >
      {po.running ? (
        <>
          <Spinner size={13} className="group-hover/po:hidden" />
          <Square size={11} strokeWidth={2} className="hidden fill-current group-hover/po:block" />
        </>
      ) : (
        <Sparkles size={15} strokeWidth={1.5} />
      )}
      <span data-composer-label>{tr(po.running ? 'promptOptimize.running' : 'promptOptimize.button')}</span>
    </button>
  )
}

/** 输入框下面那一行：写好了（撤回），或者没改成的原因（重试） */
export function PromptOptimizeNote({ po }: { po: PromptOptimizer }) {
  const note = po.note
  if (!note || po.running) return null
  const action = (label: string, run: () => void, hint?: string) => (
    <button type="button" title={hint} onClick={run} className="shrink-0 rounded px-1 text-accent-fg hover:bg-hover">
      {label}
    </button>
  )
  if (note.kind === 'done')
    return (
      <p className="flex min-w-0 items-center gap-1 px-4 pb-1.5 text-meta text-fg-muted">
        <Sparkles size={12} strokeWidth={1.5} className="shrink-0 text-accent-fg" />
        <span className="min-w-0 truncate">{tr('promptOptimize.done')}</span>
        {action(tr('promptOptimize.undo'), po.undo, tr('promptOptimize.undoHint'))}
      </p>
    )
  return (
    <p role="alert" className="flex min-w-0 flex-wrap items-center gap-x-1 px-4 pb-1.5 text-meta text-danger">
      <span className="min-w-0 break-words">
        {tr('promptOptimize.failed', { text: problemText(note, po.channelName(note.source)) })}
      </span>
      {action(tr('promptOptimize.retry'), po.start)}
    </p>
  )
}
