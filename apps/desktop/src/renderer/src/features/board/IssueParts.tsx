// 事项（docs/ui/channels-collab-v2.md §9）：卡片上的负责人和派出去的卡片、编辑里的负责人和验收标准、验收弹窗、分配规则
import { useMemo, useState } from 'react'
import { AlarmClock, Bot, CircleAlert, ExternalLink, Plus, Send, ShieldCheck, X } from 'lucide-react'
import { Button, IconButton, Select, Spinner, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { tr, translateMessage, type TranslationKey } from '@/i18n/core'
import { setPage } from '@/features/layout/page'
import { channelActions, useChannels } from '@/features/channels/store'
import { canWakeup } from '@/features/channels/WakeupParts'
import { wakeupHint, type WakeupOn } from '@/features/channels/wakeupModel'
import { FIELD, Field, useRemember } from '@/features/panel/ToolsUi'
import type { IssueAssignee, IssueLink, ManualTask } from '../../../../shared/types/project-tools'
import type { Channel, ChannelMessage } from '../../../../shared/types/channels'
import { reloadBoardTasks, updateBoardTask } from './boardTasks'
import {
  assigneeChoices,
  assigneeKey,
  canDispatch,
  rejectRequest,
  type AssigneeChoice,
  type AssignRule,
  type AssignRuleKind,
} from './issues'

const RULES_KEY = 'pixelsky.board.assignRules'
export const useAssignRules = () => useRemember<AssignRule[]>(RULES_KEY, [])

/** 当前能选的负责人（频道数据变了跟着变） */
export function useAssigneeChoices(projectId: string | null): AssigneeChoice[] {
  const channels = useChannels(s => s.channels)
  const members = useChannels(s => s.members)
  return useMemo(() => assigneeChoices(channels, members, projectId), [channels, members, projectId])
}

const STATE_KEY: Record<IssueLink['state'], TranslationKey> = {
  queued: 'board.issue.state.queued',
  approval: 'board.issue.state.approval',
  running: 'board.issue.state.running',
  waiting: 'board.issue.state.waiting',
  done: 'board.issue.state.done',
  failed: 'board.issue.state.failed',
  stopped: 'board.issue.state.stopped',
}

/** 打开频道里派出去的那张卡 */
export function openIssueCard(link: Pick<IssueLink, 'channelId' | 'taskId'>): void {
  setPage('channels')
  void channelActions.focusMessage(link.channelId, link.taskId)
}

/** 交给负责人：派一张卡；演示模式没有真的卡片，事项上写一张假的 */
export async function dispatchIssue(task: ManualTask): Promise<void> {
  const a = task.assignee
  if (!a) return
  const taskId = await channelActions.dispatchIssue(a.channelId, {
    id: task.id,
    title: task.title,
    note: task.note,
    memberId: a.memberId,
    acceptance: (task.acceptance ?? []).map(x => x.text),
  })
  if (taskId) await reloadBoardTasks()
  else
    await updateBoardTask(task.id, {
      status: 'in_progress',
      link: {
        channelId: a.channelId,
        taskId: `demo-${task.id}`,
        state: 'queued',
        round: 1,
        checks: null,
        at: Date.now(),
      },
    })
}

/**
 * 事项唤醒（docs/multica-learn.md §11.6）挂在事项派出去的那张卡上：本机频道、事项没完成、卡没停才能挂。
 * 卡片的标题和负责人从频道里读（还没读进来时用事项自己的）
 */
export function issueWakeTarget(
  task: ManualTask,
  channels: readonly Channel[],
  messages: Readonly<Record<string, readonly ChannelMessage[] | undefined>>,
): WakeupOn | null {
  const link = task.link
  if (!link || task.status === 'completed' || link.state === 'stopped') return null
  if (!canWakeup(channels.find(c => c.id === link.channelId))) return null
  const card = messages[link.channelId]?.find(m => m.id === link.taskId)
  return {
    channelId: link.channelId,
    on: link.taskId,
    kind: 'task',
    title: card?.kind === 'task' ? card.title : task.title,
    assigneeId: card?.kind === 'task' ? card.assigneeId : (task.assignee?.memberId ?? null),
  }
}

/** 卡片上的事项一行：负责人、卡片的状态和检查、验收进度、挂着的唤醒，以及「交给…」「验收」 */
export function IssueLine({
  task,
  busy,
  onDispatch,
  onReview,
  onWakeup,
}: {
  task: ManualTask
  busy: boolean
  onDispatch(): void
  onReview(): void
  /** 点「⏰ 下次 …」：打开唤醒对话框 */
  onWakeup?(): void
}) {
  const a = task.assignee
  const link = task.link
  const acceptance = task.acceptance ?? []
  const channel = useChannels(s => (link ? (s.channels.find(c => c.id === link.channelId) ?? null) : null))
  const members = useChannels(s => s.members)
  const wakeup =
    link && task.status !== 'completed'
      ? wakeupHint(channel, link.taskId, id => members.find(m => m.id === id)?.name ?? '?', Date.now())
      : null
  if (!a && !acceptance.length) return null
  const done = acceptance.filter(x => x.done).length
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <div data-issue className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 pl-6 text-meta text-fg-faint">
      {a && (
        <span className="inline-flex max-w-full items-center gap-1 truncate text-fg-muted">
          <Bot size={12} strokeWidth={1.75} className="shrink-0" />
          {a.name}
        </span>
      )}
      {link && (
        <button
          type="button"
          tabIndex={-1}
          onClick={stop(() => openIssueCard(link))}
          title={tr('board.issue.openCard')}
          className={cn(
            'press inline-flex items-center gap-1 rounded px-1 hover:bg-hover hover:text-fg',
            link.state === 'failed' && 'text-danger',
            link.state === 'waiting' && 'text-warn',
          )}
        >
          · {tr(STATE_KEY[link.state])}
          {link.state === 'failed' && <CircleAlert size={11} strokeWidth={1.75} />}
        </button>
      )}
      {link?.checks && (
        <span
          className={cn(
            'inline-flex items-center gap-1',
            link.checks.status === 'fail' && 'text-warn',
            link.checks.status === 'pass' && 'text-success',
          )}
        >
          ·{' '}
          {link.checks.status === 'running' ? (
            <>
              <Spinner size={10} />
              {tr('board.issue.checksRunning')}
            </>
          ) : link.checks.status === 'pass' ? (
            tr('board.issue.checksPass')
          ) : (
            tr('board.issue.checksFail', { n: link.checks.problems })
          )}
        </span>
      )}
      {acceptance.length > 0 && <span>· {tr('board.issue.acceptanceCount', { done, total: acceptance.length })}</span>}
      {wakeup && (
        <button
          type="button"
          tabIndex={-1}
          data-issue-wakeup
          title={wakeup.title}
          disabled={!onWakeup}
          onClick={stop(() => onWakeup?.())}
          className="press inline-flex min-w-0 items-center gap-1 rounded px-1 text-accent-fg enabled:hover:bg-hover"
        >
          · <AlarmClock size={11} strokeWidth={1.75} className="shrink-0" />
          <span className="truncate">{wakeup.text}</span>
        </button>
      )}
      {/* 操作按钮单独一行，不跟着上面的信息折行 */}
      {(canDispatch(task) || task.status === 'review') && <span className="basis-full" />}
      {a && canDispatch(task) && (
        <button
          type="button"
          tabIndex={-1}
          disabled={busy}
          data-issue-dispatch
          onClick={stop(onDispatch)}
          className="press inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-fg-secondary hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <Send size={11} strokeWidth={1.75} />
          {tr(link ? 'board.issue.redispatch' : 'board.issue.dispatch', { member: a.name })}
        </button>
      )}
      {task.status === 'review' && (
        <button
          type="button"
          tabIndex={-1}
          disabled={busy}
          data-issue-review
          onClick={stop(onReview)}
          className="press inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-accent-on disabled:opacity-50"
        >
          <ShieldCheck size={11} strokeWidth={1.75} />
          {tr('board.issue.review')}
        </button>
      )}
    </div>
  )
}

/** 编辑弹窗里的负责人和验收标准 */
export function IssueFields({
  choices,
  assignee,
  acceptance,
  suggestion,
  onAssignee,
  onAcceptance,
}: {
  choices: readonly AssigneeChoice[]
  assignee: IssueAssignee | null
  /** 一行一条 */
  acceptance: string
  /** 分配规则命中、还没设负责人时的建议 */
  suggestion: IssueAssignee | null
  onAssignee(a: IssueAssignee | null): void
  onAcceptance(text: string): void
}) {
  const current = assignee ? assigneeKey(assignee) : ''
  // 已经选了、但频道或成员没了的：仍列出来，免得一打开就被改成「我」
  const options = [
    { value: '', label: tr('board.issue.me') },
    ...choices.map(c => ({
      value: c.key,
      label: tr('board.issue.memberIn', { member: c.assignee.name, channel: c.channel }),
    })),
    ...(assignee && !choices.some(c => c.key === current) ? [{ value: current, label: assignee.name }] : []),
  ]
  return (
    <>
      <Field label={tr('board.issue.assignee')}>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            label={tr('board.issue.assignee')}
            value={current}
            options={options}
            onChange={key => onAssignee(key ? (choices.find(c => c.key === key)?.assignee ?? assignee) : null)}
          />
          {!assignee && suggestion && (
            <button
              type="button"
              onClick={() => onAssignee(suggestion)}
              className="press rounded-md px-1.5 py-0.5 text-meta text-accent-fg hover:bg-hover"
            >
              {tr('board.rules.suggest', { member: suggestion.name })}
            </button>
          )}
        </div>
        {!choices.length && <p className="mt-1 text-meta text-fg-faint">{tr('board.issue.noMembers')}</p>}
      </Field>
      <Field label={tr('board.issue.acceptance')}>
        <textarea
          value={acceptance}
          onChange={e => onAcceptance(e.target.value)}
          placeholder={tr('board.issue.acceptanceHint')}
          className={cn(FIELD, 'h-20 py-2')}
        />
      </Field>
    </>
  )
}

/** 验收：逐条勾验收标准，看检查结果；通过 = 完成，打回 = 原因作为追加要求发到卡片的串里 */
export function ReviewDialog({ task, onClose }: { task: ManualTask; onClose(): void }) {
  const members = useChannels(s => s.members)
  const [items, setItems] = useState(task.acceptance ?? [])
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const link = task.link
  const run = (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    fn()
      .then(onClose)
      .catch((e: Error) => setError(translateMessage(e.message)))
      .finally(() => setBusy(false))
  }
  const toggle = (i: number) => {
    const next = items.map((x, j) => (j === i ? { ...x, done: !x.done } : x))
    setItems(next)
    void updateBoardTask(task.id, { acceptance: next }).catch((e: Error) => setError(translateMessage(e.message)))
  }
  const reject = () =>
    run(async () => {
      const a = task.assignee
      if (!a || !link) return
      // 用成员现在的名字 @ 他：改过名时旧名字不算提及，就成了普通留言、不会再做一轮
      const name = members.find(m => m.id === a.memberId)?.name ?? a.name
      const text = rejectRequest({ acceptance: items }, name, reason, {
        text: (member, r) => tr('board.issue.rejectText', { member, reason: r }),
        unmet: tr('board.issue.rejectUnmet'),
      })
      await channelActions.postText(link.channelId, text, link.taskId)
      await updateBoardTask(task.id, { status: 'in_progress' })
    })
  return (
    <ConfirmDialog
      title={tr('board.issue.reviewTitle', { title: task.title })}
      busy={busy}
      error={error}
      confirmLabel={rejecting ? tr('board.issue.rejectSend') : tr('board.issue.pass')}
      cancelLabel={tr('board.cancel')}
      confirmDisabled={rejecting && !reason.trim()}
      danger={rejecting}
      extra={
        rejecting || !task.assignee || !link
          ? undefined
          : { label: tr('board.issue.reject'), onClick: () => setRejecting(true) }
      }
      onCancel={() => (rejecting ? setRejecting(false) : onClose())}
      onConfirm={() => (rejecting ? reject() : run(() => updateBoardTask(task.id, { status: 'completed' })))}
      description={
        <div className="mt-3 flex flex-col gap-3 text-left">
          {items.length ? (
            <ul data-acceptance className="flex flex-col gap-1">
              {items.map((x, i) => (
                <li key={i}>
                  <label className="flex cursor-pointer items-start gap-2 text-ui text-fg">
                    <input
                      type="checkbox"
                      checked={x.done}
                      onChange={() => toggle(i)}
                      className="mt-1 accent-(--color-accent)"
                    />
                    <span className={cn(x.done && 'text-fg-muted line-through')}>{x.text}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-meta text-fg-muted">{tr('board.issue.reviewNoCriteria')}</p>
          )}
          {link?.checks && link.checks.status !== 'running' && (
            <p className={cn('text-meta', link.checks.status === 'fail' ? 'text-warn' : 'text-success')}>
              {link.checks.status === 'pass'
                ? tr('board.issue.checksPass')
                : tr('board.issue.checksFail', { n: link.checks.problems })}
            </p>
          )}
          {link && (
            <button
              type="button"
              onClick={() => {
                onClose()
                openIssueCard(link)
              }}
              className="inline-flex items-center gap-1.5 self-start text-meta text-fg-muted hover:text-fg"
            >
              <ExternalLink size={13} />
              {tr('board.issue.openCard')}
            </button>
          )}
          {rejecting && (
            <textarea
              autoFocus
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={tr('board.issue.rejectReason')}
              className={cn(FIELD, 'h-20 py-2')}
            />
          )}
        </div>
      }
    />
  )
}

/** 分配规则：标签 / 项目 / 标题关键词 → 成员 */
export function RulesDialog({
  projects,
  saved,
  onSave,
  onClose,
}: {
  projects: readonly { id: string; name: string }[]
  /** 看板页那份规则：同一个窗口里两处各读一份 localStorage 不会互相同步，所以由看板页传进来 */
  saved: AssignRule[]
  onSave(rules: AssignRule[]): void
  onClose(): void
}) {
  const [rules, setRules] = useState(saved)
  const choices = useAssigneeChoices(null)
  const kinds: AssignRuleKind[] = ['tag', 'project', 'keyword']
  const patch = (id: string, change: Partial<AssignRule>) =>
    setRules(list => list.map(r => (r.id === id ? { ...r, ...change } : r)))
  const valid = rules.filter(r => r.value.trim() && r.assignee.memberId)
  return (
    <ConfirmDialog
      title={tr('board.rules.title')}
      busy={false}
      confirmLabel={tr('board.save')}
      cancelLabel={tr('board.cancel')}
      dirty={JSON.stringify(rules) !== JSON.stringify(saved)}
      onCancel={onClose}
      onConfirm={() => {
        onSave(valid.map(r => ({ ...r, value: r.value.trim() })))
        onClose()
      }}
      description={
        <div className="mt-2 flex flex-col gap-2 text-left">
          <p className="text-meta text-fg-muted">{tr('board.rules.hint')}</p>
          {!choices.length && <p className="text-meta text-fg-faint">{tr('board.issue.noMembers')}</p>}
          {!rules.length && <p className="py-2 text-meta text-fg-faint">{tr('board.rules.empty')}</p>}
          {rules.map(r => (
            // 一条规则两行：条件（哪种 + 内容）、交给谁
            <div
              key={r.id}
              data-assign-rule
              className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-1.5 rounded-lg border border-line-subtle p-2"
            >
              <Select
                label={tr('board.rules.kind.tag')}
                className="w-full"
                value={r.kind}
                options={kinds.map(k => ({ value: k, label: tr(`board.rules.kind.${k}`) }))}
                onChange={kind => patch(r.id, { kind, value: kind === 'project' ? (projects[0]?.id ?? '') : '' })}
              />
              {r.kind === 'project' ? (
                <Select
                  label={tr('board.project')}
                  className="w-full"
                  value={r.value}
                  options={projects.map(p => ({ value: p.id, label: p.name }))}
                  onChange={value => patch(r.id, { value })}
                />
              ) : (
                <input
                  value={r.value}
                  maxLength={40}
                  aria-label={tr('board.rules.value')}
                  placeholder={tr('board.rules.value')}
                  onChange={e => patch(r.id, { value: e.target.value })}
                  className={cn(FIELD, 'h-8')}
                />
              )}
              <IconButton
                icon={X}
                label={tr('board.rules.remove')}
                size={24}
                iconSize={12}
                onClick={() => setRules(list => list.filter(x => x.id !== r.id))}
              />
              <span className="pr-1 text-right text-meta text-fg-faint">→</span>
              <Select
                label={tr('board.issue.assignee')}
                className="w-full"
                value={assigneeKey(r.assignee)}
                options={choices.map(c => ({
                  value: c.key,
                  label: tr('board.issue.memberIn', { member: c.assignee.name, channel: c.channel }),
                }))}
                placeholder={r.assignee.name || tr('board.issue.assignee')}
                onChange={key => {
                  const c = choices.find(x => x.key === key)
                  if (c) patch(r.id, { assignee: c.assignee })
                }}
              />
            </div>
          ))}
          <Button
            variant="ghost"
            icon={Plus}
            className="h-8 self-start text-meta"
            disabled={!choices.length}
            onClick={() =>
              setRules(list => [
                ...list,
                { id: crypto.randomUUID(), kind: 'tag', value: '', assignee: choices[0]!.assignee },
              ])
            }
          >
            {tr('board.rules.add')}
          </Button>
        </div>
      }
    />
  )
}
