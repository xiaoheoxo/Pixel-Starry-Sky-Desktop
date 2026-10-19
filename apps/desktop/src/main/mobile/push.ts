// 网页推送（docs/mobile-remote.md §22.2）：比较前后两次会话列表，算出要提醒的；每部手机攒一会儿合成一条，
// 经云端推给不在线或页面在后台的手机。推送内容只有种类、数量、会话 id（只涉及一个会话时）和角标数，
// 不带任务标题（经过苹果 / 谷歌的推送服务；会话 id 是随机串，不含内容）。
import type { SessionSummary } from '@pixelsky/protocol'

export type PushKind = 'waiting' | 'failed' | 'completed'
export interface PushPayload {
  kind: PushKind
  count: number
  /** 这一种只涉及一个会话时带上它的 id，手机点通知直接打开那个会话；涉及多个时没有这个字段 */
  session?: string
  /** 发这条推送时，这台电脑上「等你处理」（waiting，不含归档）的会话总数，手机主屏幕图标的角标 */
  badge: number
}
/** 每种提醒涉及哪些会话（用 id 的集合算，同一个会话攒到两次也只算一个） */
export type PushSessions = Record<PushKind, Set<string>>

export const emptyPush = (): PushSessions => ({ waiting: new Set(), failed: new Set(), completed: new Set() })

/** 「等你处理」的会话数（不含归档）：推送里的角标 */
export const waitingCount = (sessions: readonly SessionSummary[] | null): number =>
  sessions?.filter(s => s.state === 'waiting' && !s.record.archivedAt).length ?? 0

/** 每部手机攒这么久合成一条 */
export const PUSH_DELAY = 2000
/** 云端同一部手机两条推送至少隔 5 秒，近了的直接丢掉；这边排到上一条之后 5.5 秒再发 */
export const PUSH_GAP = 5500
/** 几种同时有时取最要紧的 */
const ORDER: PushKind[] = ['waiting', 'failed', 'completed']

const busy = (s: SessionSummary | undefined): boolean => s?.state === 'running' || s?.state === 'starting'

/**
 * 和手机 apps/mobile/src/data/notify.ts 的规则一样，只是「等你处理」要上一份列表里有这个会话：
 * 远程机器连上时它的会话整批出现，已经在等的不算新提醒。prev 为 null（刚启动）时不算，免得把旧状态当成新消息
 */
export function pushChanges(prev: readonly SessionSummary[] | null, next: readonly SessionSummary[]): PushSessions {
  const counts = emptyPush()
  if (!prev) return counts
  const before = new Map(prev.map(s => [s.record.id, s]))
  for (const s of next) {
    if (s.record.archivedAt) continue
    const old = before.get(s.record.id)
    if (s.state === 'waiting' && old && old.state !== 'waiting') counts.waiting.add(s.record.id)
    else if (busy(old) && s.state === 'idle') {
      if (s.record.lastOutcome === 'failed') counts.failed.add(s.record.id)
      else if (s.record.lastOutcome === 'completed') counts.completed.add(s.record.id)
    }
  }
  return counts
}

/**
 * 推送里能带的会话 id：本机是 UUID，远程机器的带前缀（`ssh-<uuid>~<uuid>`、`wsl-<hex>~<uuid>`）。
 * 云端（bridgeapi/push.go）和手机（public/sw.js、platform/notifyOpen.ts）用同一个规则；不合规的不带，推送照发
 */
export const PUSH_SESSION_ID = /^[A-Za-z0-9_.:~-]{1,128}$/

export function pushPayload(sessions: PushSessions, badge = 0): PushPayload | null {
  const kind = ORDER.find(k => sessions[k].size > 0)
  if (!kind) return null
  const ids = sessions[kind]
  const only = ids.size === 1 ? [...ids][0] : null
  return {
    kind,
    count: Math.min(99, ids.size),
    ...(only && PUSH_SESSION_ID.test(only) ? { session: only } : {}),
    badge: Math.min(99, badge),
  }
}

/** 每部手机一份攒着的会话集合，到点发一次；离上一条太近就等到够远再发，期间来的并进去 */
export class PushScheduler {
  private readonly waiting = new Map<string, { sessions: PushSessions; timer: ReturnType<typeof setTimeout> }>()
  private readonly sent = new Map<string, number>()

  constructor(
    private readonly send: (phone: string, payload: PushPayload) => Promise<void>,
    private readonly delay = PUSH_DELAY,
    private readonly gap = PUSH_GAP,
    private readonly now: () => number = Date.now,
    /** 发出那一刻再取角标数（攒的这段时间里「等你处理」的数量可能变了） */
    private readonly badge: () => number = () => 0,
  ) {}

  add(phone: string, sessions: PushSessions): void {
    if (!pushPayload(sessions)) return
    const prior = this.waiting.get(phone)
    if (prior) {
      for (const k of ORDER) for (const id of sessions[k]) prior.sessions[k].add(id)
      return
    }
    const last = this.sent.get(phone)
    const wait = last === undefined ? this.delay : Math.max(this.delay, last + this.gap - this.now())
    const timer = setTimeout(() => {
      const entry = this.waiting.get(phone)
      this.waiting.delete(phone)
      const payload = entry && pushPayload(entry.sessions, this.badge())
      if (!payload) return
      this.sent.set(phone, this.now())
      void this.send(phone, payload).catch(() => {})
    }, wait)
    this.waiting.set(phone, {
      sessions: {
        waiting: new Set(sessions.waiting),
        failed: new Set(sessions.failed),
        completed: new Set(sessions.completed),
      },
      timer,
    })
  }

  /** 手机回到前台了：攒着的不用推了 */
  cancel(phone: string): void {
    const entry = this.waiting.get(phone)
    if (entry) clearTimeout(entry.timer)
    this.waiting.delete(phone)
  }

  close(): void {
    for (const phone of [...this.waiting.keys()]) this.cancel(phone)
  }
}
