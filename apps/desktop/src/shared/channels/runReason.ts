// 任务卡一轮结束的原因和运行记录（docs/multica-learn.md §1、§2、§11.1）。主进程和界面共用，不依赖 window。
import { classifyErrorText, type NoticeErrorKind } from '@pixelsky/protocol'
import type { ChannelRun, RunReason } from '../types/channels'

/** 一张卡留几条运行记录（和云端 teams.MaxRuns 一致） */
export const MAX_RUNS = 20

const REASONS: readonly RunReason[] = [
  'machine_offline',
  'queue_expired',
  'session_gone',
  'not_deployed',
  'engine.auth',
  'engine.quota',
  'engine.model',
  'engine.busy',
  'engine.context',
  'other',
]

/** 云端或别的版本写来的原因代码：认识的原样，不认识的当 other，空的当没有 */
export function parseRunReason(v: unknown): RunReason | null {
  if (typeof v !== 'string' || !v) return null
  return (REASONS as readonly string[]).includes(v) ? (v as RunReason) : 'other'
}

const ENGINE: Record<NoticeErrorKind, RunReason> = {
  auth: 'engine.auth',
  balance: 'engine.quota',
  route: 'engine.model',
  busy: 'engine.busy',
  overflow: 'engine.context',
}

/** 执行端自己写的几种失败（文字和 service.ts、team/executor.ts 里的一致） */
const PLATFORM: Record<string, RunReason> = {
  会话已删除: 'session_gone',
  '这个 AI 成员已被删除': 'not_deployed',
  '这台电脑上没有这项活的记录，请重新派活': 'not_deployed',
}

/** 一轮结束时的原因：只有失败才归类（停止、完成没有原因）；引擎的报错按协议包的归类，认不出的是 other */
export function runReasonOf(status: ChannelRun['status'], error: string | null | undefined): RunReason | null {
  if (status !== 'failed') return null
  const text = error?.trim() ?? ''
  if (!text) return 'other'
  const platform = PLATFORM[text]
  if (platform) return platform
  const kind = classifyErrorText(text)
  return kind ? ENGINE[kind] : 'other'
}

/** 接上一条运行记录：同一轮、同一个结束时间的不重复，最多 MAX_RUNS 条（丢最旧的） */
export function appendRun(list: readonly ChannelRun[] | undefined, run: ChannelRun): ChannelRun[] {
  const old = list ?? []
  if (old.some(r => r.n === run.n && r.endedAt === run.endedAt)) return [...old]
  return [...old, run].slice(-MAX_RUNS)
}
