import { setTimeout as delay } from 'node:timers/promises'
import { open } from 'node:fs/promises'
import type {
  ApprovalDecision,
  FileAttachment,
  ImageAttachment,
  SessionSettings,
  WorkflowRun,
} from '@pixelsky/protocol'
import type { ChatSeed } from '../chat-log'
import { DOT_FILE_LIMIT, dotRetryable } from './client'
import type { EngineSession, SessionContext } from '../adapter'
import type { DotClient, DotIdentity, DotMessage, DotWorkflow } from './client'

export interface DotSessionOptions {
  pollMs?: number
  /** 发出后最多等多久收到 Dot 的回复，超时报错 */
  replyTimeoutMs?: number
  /** 收到回复后 Dot 还在主对话里干活，最多再陪它等多久；到点按完成结束，排队的消息接着发（docs/ui/dot-optimize.md §9） */
  busyTimeoutMs?: number
  /** 读取出错后隔多久再试，试完这几次还不行才报错 */
  retryMs?: readonly number[]
  acquire?: (dot: DotIdentity) => () => void
}

const terminal = (status: DotWorkflow['status']) => ['completed', 'failed', 'interrupted'].includes(status)
const dotFlags = (steerAvailable: boolean) => ({
  steerAvailable,
  ultracodeAvailable: null,
  fastAvailable: null,
  fastState: null,
  fastBlocked: null,
})
const RETRY_MS: readonly number[] = [1500, 3000, 6000, 12_000]

type DotTurn = {
  abort: AbortController
  done?: Promise<void>
  dot?: DotIdentity
  guidance?: Promise<void>
  guidanceVersion: number
  lastGuidanceId?: string
}

/** Chat and delegated work have separate lifetimes. Closing only detaches the local client. */
export class DotSession implements EngineSession {
  private closed = false
  private turn: DotTurn | null = null
  private readonly abort = new AbortController()
  private readonly watches = new Map<string, Promise<void>>()
  private readonly workflows = new Map<string, WorkflowRun>()

  constructor(
    private readonly client: DotClient,
    private readonly ctx: SessionContext,
    private readonly options: DotSessionOptions = {},
  ) {
    for (const workflow of ctx.runs?.().workflows ?? []) this.workflows.set(workflow.id, workflow)
  }

  send(
    text: string,
    turnId: string,
    userItemId: string,
    attachments?: ImageAttachment[],
    _seed?: ChatSeed,
    _handoffImages?: ImageAttachment[],
    files?: FileAttachment[],
  ): void {
    if (this.closed || this.turn) throw new Error('Dot session closed or busy')
    if (attachments?.length) throw new Error('Dot image input is not supported')
    const turn: DotTurn = { abort: new AbortController(), guidanceVersion: 0 }
    this.turn = turn
    this.ctx.emit({ type: 'flags', flags: dotFlags(false) })
    turn.done = this.run(text, turnId, userItemId, turn, files).finally(() => {
      this.turn = null
    })
  }

  async steer(text: string, userItemId: string, _images?: ImageAttachment[], files?: FileAttachment[]): Promise<void> {
    const turn = this.turn
    if (!turn?.dot || turn.guidance) throw new Error('Dot is not ready to receive guidance')
    const { dot } = turn
    const signal = turn.abort.signal
    turn.guidanceVersion++
    const delivery = (async () => {
      const fileIds = await this.upload(dot, files ?? [], signal)
      const sent = await this.client.send(dot, text, userItemId, signal, fileIds)
      turn.lastGuidanceId = sent.id
      this.ctx.emit({ type: 'input_ack', id: userItemId, state: 'consumed' })
    })().catch(error => {
      this.ctx.emit({ type: 'input_ack', id: userItemId, state: 'uncertain' })
      throw error
    })
    turn.guidance = delivery
    try {
      await delivery
    } finally {
      turn.guidance = undefined
    }
  }

  private async run(
    text: string,
    turnId: string,
    userItemId: string,
    turn: DotTurn,
    files: FileAttachment[] = [],
  ): Promise<void> {
    const signal = turn.abort.signal
    let attempted = false
    let confirmed = false
    let release: (() => void) | undefined
    try {
      const dot = await this.client.discover(signal)
      release = this.options.acquire?.(dot)
      const previous = this.ctx.record().engineSessionId
      if (previous && previous !== dot.threadId)
        throw new Error('Dot thread changed; select the current Dot in a new session')
      this.ctx.setEngineSessionId(dot.threadId)
      const fileIds = await this.upload(dot, files, signal)
      attempted = true
      // Stable request ID across ambiguous transport responses. No implicit resend.
      const sent = await this.client.send(dot, text, userItemId, signal, fileIds)
      confirmed = true
      this.ctx.emit({ type: 'input_ack', id: userItemId, state: 'consumed' })
      turn.dot = dot
      this.ctx.emit({ type: 'flags', flags: dotFlags(true) })
      let after = sent.id
      let received = false
      let asked = false
      const emitted = new Set<string>()
      const start = Date.now()
      const replyTimeout = this.options.replyTimeoutMs ?? 10 * 60_000
      const busyTimeout = this.options.busyTimeoutMs ?? 60 * 60_000
      let replyDeadline = start + replyTimeout
      let busyDeadline = start + busyTimeout
      let acknowledgedGuidance: string | undefined
      let awaitingGuidanceReply = false
      for (;;) {
        signal.throwIfAborted()
        // Do not advance the room cursor past a guidance message before its POST has settled.
        if (turn.guidance) {
          await turn.guidance.catch(() => undefined)
          continue
        }
        const version = turn.guidanceVersion
        if (acknowledgedGuidance !== turn.lastGuidanceId) {
          acknowledgedGuidance = turn.lastGuidanceId
          awaitingGuidanceReply = true
          received = false
          asked = false
          replyDeadline = Date.now() + replyTimeout
          busyDeadline = Date.now() + busyTimeout
        }
        if (!received && Date.now() >= replyDeadline)
          throw new Error('Dot reply wait timed out; check ChatGPT before continuing')
        if (received && Date.now() >= busyDeadline) {
          this.ctx.emit({
            type: 'item_completed',
            item: {
              id: `dot-still-working-${sent.id}`,
              kind: 'notice',
              level: 'info',
              text: 'Dot is still working; follow up in ChatGPT',
            },
          })
          break
        }
        const from = after
        const messages = await this.poll(() => this.client.messages(dot, from, signal), signal)
        for (const m of messages) {
          if (version !== turn.guidanceVersion) break
          after = m.id
          if (m.id === acknowledgedGuidance) awaitingGuidanceReply = false
          if (m.account_user_id !== dot.memberId || m.deleted_at || emitted.has(m.id)) continue
          emitted.add(m.id)
          if (!awaitingGuidanceReply) received = true
          if (m.content.text)
            this.ctx.emit({
              type: 'item_completed',
              item: {
                id: `dot-${m.id}`,
                kind: 'assistant',
                text: m.content.text,
                status: 'completed',
              },
            })
          for (const attachment of m.content.attachments ?? []) {
            if (attachment.type === 'thread' && attachment.thread_id) {
              try {
                await this.refresh(dot, m, attachment.thread_id, signal)
              } catch {
                signal.throwIfAborted()
                this.monitorNotice(attachment.thread_id)
              }
              this.watch(dot, m, attachment.thread_id)
            } else {
              this.ctx.emit({
                type: 'item_completed',
                item: {
                  id: `dot-attachment-${m.id}`,
                  kind: 'notice',
                  level: 'info',
                  text: 'View the Dot attachment in ChatGPT',
                },
              })
            }
          }
          if (m.content.elicitation) {
            asked = true
            this.ctx.emit({
              type: 'item_completed',
              item: {
                id: `dot-approval-${m.id}`,
                kind: 'notice',
                level: 'info',
                text: 'Dot needs your input in ChatGPT',
              },
            })
          }
        }
        if (version !== turn.guidanceVersion) continue
        if (received) {
          const activity = await this.poll(() => this.client.activity(dot, signal), signal)
          if (version !== turn.guidanceVersion) continue
          if (activity === 'systemError') throw new Error('Dot reported a system error; open ChatGPT')
          // 等你在 ChatGPT 里确认 / 回答：这一轮到此为止，排队的消息（可能就是回答）接着发
          if (activity === 'waiting') {
            if (!asked)
              this.ctx.emit({
                type: 'item_completed',
                item: {
                  id: `dot-waiting-${sent.id}`,
                  kind: 'notice',
                  level: 'info',
                  text: 'Dot needs your input in ChatGPT',
                },
              })
            break
          }
          // 不在忙就算这一轮结束（idle 之外 notLoaded 等也算）；还在忙就接着等它的新回复
          if (activity !== 'active') break
        }
        await delay(this.options.pollMs ?? 1500, undefined, { signal })
      }
      this.ctx.emit({
        type: 'turn_completed',
        turnId,
        outcome: 'completed',
        error: null,
        background: this.background(),
      })
    } catch (error) {
      // A poll can fail while the user is sending guidance. Settle that delivery before ending the turn.
      await turn.guidance?.catch(() => undefined)
      if (attempted && !confirmed) this.ctx.emit({ type: 'input_ack', id: userItemId, state: 'uncertain' })
      this.ctx.emit({
        type: 'turn_completed',
        turnId,
        outcome: signal.aborted ? 'interrupted' : 'failed',
        error: signal.aborted ? null : error instanceof Error ? error.message : 'Dot request failed',
        background: this.background(),
      })
    } finally {
      release?.()
    }
  }

  private async upload(dot: DotIdentity, files: FileAttachment[], signal: AbortSignal): Promise<string[]> {
    const fileIds: string[] = []
    if (files.length > 10) throw new Error('Dot supports at most 10 attachments per message')
    for (const file of files) {
      if (!file.path) throw new Error('Dot attachment requires a local file')
      const handle = await open(file.path, 'r')
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > DOT_FILE_LIMIT)
          throw new Error('Dot attachment exceeds 20 MiB or is not a file')
        if (info.size !== file.bytes) throw new Error('Dot attachment changed; select it again')
        const data = new Uint8Array(info.size + 1)
        let size = 0
        while (size < data.length) {
          signal.throwIfAborted()
          const result = await handle.read(data, size, data.length - size)
          if (!result.bytesRead) break
          size += result.bytesRead
        }
        if (size > DOT_FILE_LIMIT) throw new Error('Dot attachment exceeds 20 MiB')
        if (size !== info.size || (await handle.stat()).mtimeMs !== info.mtimeMs)
          throw new Error('Dot attachment changed; select it again')
        fileIds.push(await this.client.upload(dot, { name: file.name, data: data.subarray(0, size) }, signal))
      } finally {
        await handle.close()
      }
    }
    return fileIds
  }

  /**
   * 读取类请求（查新消息、查状态、查任务）出错：连不上、5xx、429 隔一会儿再试，别的错马上报。
   * 发送不走这里：失败的回应也可能已经送达，不能重发
   */
  private async poll<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const waits = this.options.retryMs ?? RETRY_MS
    for (let attempt = 0; ; attempt++) {
      try {
        return await read()
      } catch (error) {
        signal.throwIfAborted()
        if (attempt >= waits.length || !dotRetryable(error)) throw error
        await delay(waits[attempt], undefined, { signal })
      }
    }
  }

  private background(): number {
    return [...this.watches.keys()].filter(
      id => !['completed', 'failed', 'interrupted'].includes(this.workflows.get(id)?.status ?? ''),
    ).length
  }

  private async refresh(dot: DotIdentity, card: DotMessage, id: string, signal: AbortSignal): Promise<boolean> {
    const task = await this.poll(() => this.client.workflow(dot, card, id, signal), signal)
    this.workflows.set(id, {
      id,
      name: task.title,
      description: card.content.text ?? '',
      status: task.status,
      startedAt: task.startedAt,
      durationMs: task.startedAt ? Math.max(0, task.updatedAt - task.startedAt) : 0,
      // The endpoint does not report token or tool totals. Do not fabricate usage events.
      tokens: 0,
      toolCalls: 0,
      phases: [],
      agents: [],
      // 派出这个任务的那条 Dot 消息（会话里的条目 id）：界面把任务卡片放在它下面
      toolUseId: `dot-${card.id}`,
    })
    this.ctx.emit({ type: 'runs', runs: { workflows: [...this.workflows.values()], agents: [] } })
    this.ctx.emit({ type: 'background', count: this.background() })
    if (task.status === 'needsInput')
      this.ctx.emit({
        type: 'item_completed',
        item: {
          id: `dot-input-${id}`,
          kind: 'notice',
          level: 'info',
          text: 'Dot workflow needs your input in ChatGPT',
        },
      })
    return terminal(task.status)
  }

  private monitorNotice(id: string): void {
    this.ctx.emit({
      type: 'item_completed',
      item: {
        id: `dot-watch-${id}`,
        kind: 'notice',
        level: 'warn',
        text: 'Dot workflow status unavailable. Review it in ChatGPT',
      },
    })
  }

  private watch(dot: DotIdentity, card: DotMessage, id: string): void {
    if (
      this.watches.has(id) ||
      this.closed ||
      (this.workflows.get(id) && ['completed', 'failed', 'interrupted'].includes(this.workflows.get(id)!.status))
    )
      return
    const signal = this.abort.signal
    const done = (async () => {
      try {
        for (;;) {
          await delay(this.options.pollMs ?? 3000, undefined, { signal })
          if (await this.refresh(dot, card, id, signal)) return
        }
      } catch {
        if (!signal.aborted) this.monitorNotice(id)
      } finally {
        this.watches.delete(id)
        if (!signal.aborted) this.ctx.emit({ type: 'background', count: this.background() })
      }
    })()
    this.watches.set(id, done)
    this.ctx.emit({ type: 'background', count: this.background() })
  }

  // There is no verified native cancellation/approval endpoint in this integration.
  async interrupt(): Promise<void> {
    throw new Error('Stop Dot work in ChatGPT')
  }
  answer(_requestId: string, _decision: ApprovalDecision): void {
    throw new Error('Review Dot approvals in ChatGPT')
  }
  async update(_patch: Partial<SessionSettings>): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true
    this.turn?.abort.abort()
    this.abort.abort()
    await this.turn?.done
    await Promise.allSettled(this.watches.values())
  }
}
