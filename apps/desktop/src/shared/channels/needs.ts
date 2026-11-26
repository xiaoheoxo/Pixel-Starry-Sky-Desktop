// 「需要你」（docs/ui/channels-collab-v2.md §2）：从本机频道的消息里找出等你处理的事和还在跟进的活。纯函数，不碰磁盘和引擎
import type { ChannelFollow, ChannelMessage, ChannelNeed, ChannelRun, ChannelTask, NeedGone } from '../types/channels'
import { checkProblems } from '../types/checks'
import { threadMessages } from './threads'

const ACTIVE = new Set<ChannelTask['status']>(['queued', 'approval', 'running', 'waiting'])

/** 你在这张卡之后有没有回过它（引用、在串里发言）：回过就算「要你决定」处理了 */
function answered(list: readonly ChannelMessage[], task: ChannelTask, selfId: string, since: number): boolean {
  // 卡片串里的都算：引用卡片或它的结果、发在串里（含在结果上开的串）
  return threadMessages(list, task.id).some(m => m.authorId === selfId && m.at > since)
}

/** 留下现在这条「要你决定」的那一轮：最后一轮不是唤醒轮、或是做完了且不是 [silent] 的唤醒轮 */
function decisionRun(runs: readonly ChannelRun[]): ChannelRun | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]
    if (!r.wakeup || (r.status === 'done' && !r.wakeup.silent)) return r
  }
  return undefined
}

/**
 * 卡片在等你决定（docs/ui/channels-collab-v2.md §3.1）：做完了、带「需要你决定」、提出它的那一轮之后你还没回过。
 * since 是那一轮结束的时间，from 是那一轮（事项唤醒回 [silent] 的几轮不算，§11.6）。
 * 主进程判断串里的话要不要交给负责人、「需要你」、串里输入框的回答条都用它
 */
export function pendingDecision(
  list: readonly ChannelMessage[],
  task: ChannelTask,
  selfId: string,
): { since: number; from: ChannelRun | undefined } | null {
  if (task.status !== 'done' || !task.decision) return null
  // 事项唤醒回 [silent]、没做完的几轮不改要你决定的事：按提出它的那一轮算回过没有、标没标过，不然每静默一轮都重新冒出来
  const from = task.runs?.at(-1)?.wakeup ? decisionRun(task.runs) : undefined
  const since = from?.endedAt ?? task.endedAt ?? task.at
  return answered(list, task, selfId, since) ? null : { since, from }
}

export const awaitsDecision = (list: readonly ChannelMessage[], task: ChannelTask, selfId: string): boolean =>
  !!pendingDecision(list, task, selfId)

function taskSession(list: readonly ChannelMessage[], taskId: string): string | null {
  const t = list.find(x => x.id === taskId)
  return t?.kind === 'task' ? (t.sessionId ?? null) : null
}

/** 能不能「标为已处理」（§2.1）：会话还在的「要你确认」不行，得允许 / 拒绝 */
export function canMarkNeed(need: Pick<ChannelNeed, 'kind' | 'gone'>): boolean {
  return need.kind !== 'approval' || !!need.gone
}

/**
 * 所有本机频道里等你处理的事（needs，含找不到目标的）、标为已处理且状态没变的（done）、跟进中的活。
 * c.needsDone：标为已处理时记下的 key → sig；gone：判断找不到目标（主进程才知道会话和成员在不在）
 */
export function channelNeeds(
  channels: Iterable<{ id: string; archivedAt?: number | null; needsDone?: Record<string, string> }>,
  messages: ReadonlyMap<string, readonly ChannelMessage[]>,
  selfId: string,
  gone?: (need: ChannelNeed) => NeedGone | null,
): { needs: ChannelNeed[]; done: ChannelNeed[]; following: ChannelFollow[] } {
  const needs: ChannelNeed[] = []
  const done: ChannelNeed[] = []
  const following: ChannelFollow[] = []
  for (const c of channels) {
    if (c.archivedAt) continue
    const list = messages.get(c.id) ?? []
    const found: ChannelNeed[] = []
    for (const m of list) {
      const base = { channelId: c.id, at: m.at }
      if (m.kind === 'message') {
        if (m.proposal?.state === 'open')
          found.push({
            ...base,
            key: `proposal:${m.id}`,
            kind: 'proposal',
            sig: 'open',
            memberId: m.proposal.assigneeId,
            messageId: m.id,
            text: m.proposal.request,
          })
        if (m.memberChange?.state === 'open')
          found.push({
            ...base,
            key: `member:${m.id}`,
            kind: 'member',
            sig: 'open',
            memberId: m.memberChange.memberId,
            messageId: m.id,
            text: m.text,
          })
        if (m.alert?.state === 'open')
          found.push({
            ...base,
            key: `alert:${m.id}`,
            kind: 'alert',
            rule: m.alert.rule,
            sig: 'open',
            memberId: null,
            messageId: m.id,
            taskId: m.alert.taskId ?? null,
            sessionId: (m.alert.taskId && taskSession(list, m.alert.taskId)) || null,
            text: m.text,
          })
        // 流程（channels-pipeline.md §4）：草稿等你确认、自己停下了等你看（你点的暂停不算）
        const flow = m.flow
        if (flow?.status === 'draft' || (flow?.status === 'paused' && flow.paused)) {
          const step = flow.paused ? flow.steps.find(s => s.id === flow.paused!.stepId) : undefined
          found.push({
            ...base,
            key: `flow:${m.id}`,
            kind: 'flow',
            // 提案改了一版就重新出现
            sig: flow.status === 'draft' ? `draft:${flow.rev ?? 0}` : `${flow.paused?.reason}:${flow.paused?.stepId}`,
            memberId: step?.memberId ?? null,
            messageId: m.id,
            taskId: step?.taskId ?? null,
            pause: flow.status === 'paused' ? (flow.paused?.reason ?? null) : null,
            limit: flow.paused?.limit ?? null,
            text: flow.title,
            detail: step?.title ?? null,
          })
        }
        // 人工关卡（第 12 项）：每一步等你确认各一条；停止了的流程不算
        if (flow && (flow.status === 'running' || flow.status === 'paused'))
          for (const s of flow.steps)
            if (s.status === 'gated')
              found.push({
                ...base,
                key: `flow:${m.id}:gate:${s.id}`,
                kind: 'flow',
                sig: `gate:${s.taskId}:${s.result?.summary ?? ''}`.slice(0, 200),
                memberId: s.memberId,
                messageId: m.id,
                taskId: s.taskId,
                pause: 'gate',
                stepId: s.id,
                text: flow.title,
                detail: s.title,
              })
        // 一步用 user_ask 在问你（回答在流程卡上写）
        if (flow && (flow.status === 'running' || flow.status === 'paused'))
          for (const s of flow.steps)
            if (s.question)
              found.push({
                ...base,
                key: `flow:${m.id}:ask:${s.id}`,
                kind: 'flow',
                sig: `ask:${s.question.at}`,
                memberId: s.memberId,
                messageId: m.id,
                taskId: s.taskId,
                pause: 'ask',
                stepId: s.id,
                text: flow.title,
                detail: s.question.text,
              })
        continue
      }
      if (m.kind !== 'task') continue
      const task = {
        ...base,
        at: m.endedAt ?? m.at,
        memberId: m.assigneeId,
        taskId: m.id,
        sessionId: m.sessionId ?? null,
        text: m.title,
      }
      const round = m.round ?? 1
      if (m.status === 'waiting' && m.request)
        found.push({
          ...task,
          key: `approval:${m.id}`,
          kind: 'approval',
          sig: m.request.requestId,
          request: m.request,
        })
      else if (m.status === 'queued' && m.relay?.held)
        found.push({
          ...task,
          key: `held:${m.id}`,
          kind: 'held',
          sig: `${m.relay.held}:${m.relay.hop}`,
          detail: m.relay.held,
        })
      else if (m.status === 'failed')
        found.push({ ...task, key: `failed:${m.id}`, kind: 'failed', sig: String(round), detail: m.error ?? null })
      else if (m.status === 'done') {
        const problems = m.checks?.status === 'done' ? checkProblems(m.checks) : null
        if (problems && (problems.failed.length || problems.findings.length))
          found.push({
            ...task,
            key: `checks:${m.id}`,
            kind: 'checks',
            sig: m.checks!.id,
            detail: problems.failed.map(f => f.label).join(' · ') || null,
            findings: problems.findings.length,
          })
        const pending = pendingDecision(list, m, selfId)
        if (pending)
          found.push({
            ...task,
            at: pending.since,
            key: `decision:${m.id}`,
            kind: 'decision',
            sig: `${pending.from?.n ?? round}`,
            detail: m.decision,
          })
      }
      if (ACTIVE.has(m.status) && !(m.status === 'queued' && m.relay?.held) && m.status !== 'waiting')
        following.push({
          channelId: c.id,
          taskId: m.id,
          memberId: m.assigneeId,
          title: m.title,
          status: m.status,
          at: m.at,
          sessionId: m.sessionId ?? null,
        })
    }
    for (const n of found) {
      const why = gone?.(n) ?? null
      const need = why ? { ...n, gone: why } : n
      if (canMarkNeed(need) && c.needsDone?.[n.key] === n.sig) done.push(need)
      else needs.push(need)
    }
  }
  needs.sort((a, b) => b.at - a.at)
  done.sort((a, b) => b.at - a.at)
  following.sort((a, b) => b.at - a.at)
  return { needs, done, following }
}
