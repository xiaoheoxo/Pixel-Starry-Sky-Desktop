// 一句话建成员（docs/ui/channels-member-quickstart-memory.md §A）：添加成员对话框顶部，说一句话让 AI 把表单填好，
// 用户看一眼再点「添加」。通道、模型和 AI 写提交信息共用（设置 › 模型）；对话框关掉就停掉这次（不让花钱的调用接着跑）
import { useEffect, useRef, useState } from 'react'
import { Sparkles, Square } from 'lucide-react'
import type { AiMemberDraft, AiProblem, AiSource } from '../../../../shared/types/ai'
import { MEMBER_DRAFT_TEXT_LIMIT } from '../../../../shared/types/ai'
import { Button, Spinner } from '@/ui'
import { tr } from '@/i18n/core'
import { effectiveSource, useAiCommitSettings } from '@/features/settings/aiCommit'
import { useCommitChannels } from '@/features/settings/models/useCommitChannels'
import { channelRequest, problemText } from '@/features/panel/git/AiCommit'

type Note =
  | { kind: 'done'; count: number }
  | { kind: 'error'; problem: AiProblem; detail: string; model: string; source: AiSource }

const EXAMPLES = [
  'channels.agent.quick.example1',
  'channels.agent.quick.example2',
  'channels.agent.quick.example3',
] as const

/**
 * context()：给模型看的可选项（memberDraftContext）；apply：把草稿对到表单上，返回采纳了几项；
 * onState：打了字没有（算没保存的改动）、是不是正在填（表单先锁住，免得结果盖掉手改的）
 */
export function MemberQuickFill({
  context,
  apply,
  onState,
}: {
  context: () => string
  apply: (draft: AiMemberDraft) => number
  onState: (state: { typed: boolean; running: boolean }) => void
}) {
  const { model } = useAiCommitSettings()
  const channels = useCommitChannels()
  const source = effectiveSource(model, channels.ctx)
  const [text, setText] = useState('')
  const [running, setRunning] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  /** 正在等的那次；停了、关了就清掉，晚到的结果不认 */
  const active = useRef<string | null>(null)
  // 结果回来时按表单最新的样子对（等的时候用户可能换了引擎、来源）
  const latest = useRef({ context, apply })
  latest.current = { context, apply }
  const input = useRef<HTMLInputElement>(null)
  const typed = !!text.trim()
  useEffect(() => onState({ typed, running: running !== null }), [typed, running, onState])
  useEffect(
    () => () => {
      if (active.current) void window.pixelsky?.ai.cancel(active.current)
      active.current = null
    },
    [],
  )

  const stop = () => {
    if (running) void window.pixelsky?.ai.cancel(running)
    active.current = null
    setRunning(null)
  }

  const start = async (): Promise<void> => {
    const api = window.pixelsky?.ai
    const said = text.trim()
    if (running || !api || !said) return
    const requestId = crypto.randomUUID()
    active.current = requestId
    setNote(null)
    setRunning(requestId)
    const fail = (problem: AiProblem, detail: string, name: string) =>
      setNote({ kind: 'error', problem, detail, model: name, source })
    try {
      const channel = await channelRequest(source, model, channels)
      if (active.current !== requestId) return
      if ('problem' in channel) return fail(channel.problem, channel.detail, model.model)
      const result = await api.memberDraft({
        requestId,
        ...channel.request,
        text: said,
        context: latest.current.context(),
      })
      if (active.current !== requestId) return
      if (!result.ok) {
        if (result.problem !== 'cancelled') fail(result.problem, result.detail, channel.request.model)
        return
      }
      const count = latest.current.apply(result.draft)
      if (count) setNote({ kind: 'done', count })
      else fail('empty', '', channel.request.model)
    } catch (e) {
      if (active.current === requestId) fail('failed', (e as Error)?.message ?? '', model.model)
    } finally {
      if (active.current === requestId) active.current = null
      setRunning(id => (id === requestId ? null : id))
    }
  }

  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-line-subtle bg-subtle p-2.5">
      <span className="flex items-center gap-1.5 text-meta font-medium text-fg-muted">
        <Sparkles size={13} strokeWidth={1.5} className="text-accent-fg" />
        {tr('channels.agent.quick.title')}
      </span>
      <div className="flex gap-2">
        <input
          ref={input}
          value={text}
          maxLength={MEMBER_DRAFT_TEXT_LIMIT}
          placeholder={tr('channels.agent.quick.placeholder')}
          aria-label={tr('channels.agent.quick.title')}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            // 回车是填表，不是提交整个对话框
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void start()
            }
          }}
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 text-ui text-fg outline-none placeholder:text-fg-faint focus:border-accent-line focus:ring-2 focus:ring-composer-ring"
        />
        <Button
          className="h-8 shrink-0 gap-1 px-2.5 text-meta"
          disabled={!running && !text.trim()}
          onClick={() => (running ? stop() : void start())}
        >
          {running ? (
            <>
              <Spinner size={12} />
              <Square size={10} strokeWidth={2} className="fill-current" />
              {tr('channels.agent.quick.stop')}
            </>
          ) : (
            tr('channels.agent.quick.fill')
          )}
        </Button>
      </div>
      {!text && !note && (
        <div className="flex flex-wrap gap-1">
          {EXAMPLES.map(k => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setText(tr(k))
                input.current?.focus()
              }}
              className="rounded px-1.5 py-0.5 text-meta text-fg-faint hover:bg-hover hover:text-fg"
            >
              {tr(k)}
            </button>
          ))}
        </div>
      )}
      {note?.kind === 'done' && !running && (
        <p className="text-meta text-fg-muted">{tr('channels.agent.quick.done', { n: note.count })}</p>
      )}
      {note?.kind === 'error' && !running && (
        <p role="alert" className="text-meta text-danger">
          {tr('channels.agent.quick.failed', { text: problemText(note, channels.name(note.source)) })}
        </p>
      )}
      <p className="text-meta text-fg-faint">
        {tr('channels.agent.quick.via', { via: `${channels.name(source)} · ${channels.modelLabel(source, model)}` })}
      </p>
    </section>
  )
}

/** 表单上 AI 填过的字段下面那一行：哪一项、为什么这么填；用户改了这个字段就不再显示 */
export function AiFilled({ field, reason }: { field: string; reason: string | undefined }) {
  if (reason === undefined) return null
  return (
    <p className="-mt-0.5 flex items-start gap-1 text-meta text-warn">
      <Sparkles size={11} strokeWidth={1.5} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">
        {reason ? tr('channels.agent.quick.reason', { field, reason }) : tr('channels.agent.quick.filled', { field })}
      </span>
    </p>
  )
}
