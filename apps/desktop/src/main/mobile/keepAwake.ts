// 「对话运行时不让电脑睡眠」的判断（设置 › 通知）：这里不碰 electron，只看会话列表
import type { SessionSummary } from '@pixelsky/protocol'

/** 等你审批时最多保持多久：忘了审批不能让笔记本一直不睡、把电耗光 */
export const WAITING_AWAKE_MS = 30 * 60_000

export class AwakeTracker {
  private readonly waitingSince = new Map<string, number>()

  /** recheckAt：等审批的时限到了要重算一次；没有在时限内等审批的会话时为 null */
  update(sessions: readonly SessionSummary[], now: number): { awake: boolean; recheckAt: number | null } {
    const live = sessions.filter(s => !s.record.archivedAt)
    const busy = live.some(s => s.state === 'running' || s.state === 'starting' || (s.background ?? 0) > 0)
    const waiting = new Set(live.filter(s => s.state === 'waiting').map(s => s.record.id))
    for (const id of this.waitingSince.keys()) if (!waiting.has(id)) this.waitingSince.delete(id)
    let recheckAt: number | null = null
    for (const id of waiting) {
      const since = this.waitingSince.get(id) ?? now
      this.waitingSince.set(id, since)
      const end = since + WAITING_AWAKE_MS
      if (now < end && (recheckAt === null || end < recheckAt)) recheckAt = end
    }
    return { awake: busy || recheckAt !== null, recheckAt }
  }
}
