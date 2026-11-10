// 主动提醒（docs/ui/channels-collab-v2.md §6）：规则的默认开关、每条提醒能点的按钮、判断「可能删掉别人改动」的命令。
// 主进程判断什么时候提醒，界面照这里显示按钮
import type { ChannelAlertRule } from '../types/channels'

/** 频道里每条规则开没开；没设过按默认 */
export type ChannelAlertRules = Record<ChannelAlertRule, boolean>

export const DEFAULT_ALERT_RULES: Readonly<ChannelAlertRules> = {
  conflict: true,
  waiting: true,
  stalled: true,
  unclaimed: false,
  digest: false,
}

export const ALERT_RULES: readonly ChannelAlertRule[] = ['conflict', 'waiting', 'stalled', 'unclaimed', 'digest']

/** 等你回答多久、多久没进展、排队多久没人接（分钟） */
export const WAITING_MINUTES = 10
export const STALLED_MINUTES = 15
export const UNCLAIMED_MINUTES = 10
/** 每日简报默认几点发；可以改成 0–23 */
export const DIGEST_HOUR = 9

export function alertRulesOf(channel: { alerts?: Partial<ChannelAlertRules> | null }): ChannelAlertRules {
  return { ...DEFAULT_ALERT_RULES, ...(channel.alerts ?? {}) }
}

/** 整理界面传来的规则：只留认识的、布尔值的 */
export function cleanAlertRules(raw: unknown): Partial<ChannelAlertRules> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return Object.fromEntries(ALERT_RULES.filter(k => typeof r[k] === 'boolean').map(k => [k, r[k] as boolean]))
}

/** 审查打回上限（docs/ui/channels-local-rest.md §3.3 d）：默认 3，可以改成 1–10 */
export const DEFAULT_MAX_REJECTS = 3
export const MAX_REJECTS_RANGE = [1, 10] as const
/** 「没进展」提醒可选的分钟数 */
export const STALLED_CHOICES = [5, 10, 15, 20, 30, 45, 60, 90, 120] as const

export function cleanMaxRejects(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= MAX_REJECTS_RANGE[0] && raw <= MAX_REJECTS_RANGE[1]
    ? raw
    : DEFAULT_MAX_REJECTS
}

export function cleanStalledMinutes(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 5 && raw <= 120 ? raw : STALLED_MINUTES
}

export function cleanDigestHour(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : DIGEST_HOUR
}

/** 提醒上的按钮：hold 先暂停它 / continue 照常继续 / open 打开会话 / stop 停止 / reassign 换人 / cancel 取消 / dismiss 知道了 */
export type ChannelAlertAction = 'hold' | 'continue' | 'open' | 'stop' | 'reassign' | 'cancel' | 'dismiss'

const ACTIONS: Record<ChannelAlertRule, ChannelAlertAction[]> = {
  conflict: ['hold', 'continue'],
  waiting: ['open', 'dismiss'],
  stalled: ['open', 'stop'],
  unclaimed: ['reassign', 'cancel'],
  digest: ['dismiss'],
}

export function alertActions(rule: ChannelAlertRule): ChannelAlertAction[] {
  return ACTIONS[rule]
}

/** git 和子命令之间的全局选项（-C 目录、-c 键=值、--no-pager 等） */
const GIT = String.raw`\bgit(?:\s+-{1,2}[\w-]+(?:[ =](?!-)\S+)?)*\s+`

/**
 * 会丢掉工作区里没提交改动的 git 命令：checkout / switch / restore 文件或分支、reset --hard、clean -f、stash（含 drop / clear）。
 * 只看命令文字，可能误报，所以只是提醒并先停下等你决定
 */
const DANGEROUS = [
  new RegExp(GIT + String.raw`checkout\b`, 'i'),
  new RegExp(GIT + String.raw`switch\b.*(?:--discard-changes|-f\b|--force)`, 'i'),
  new RegExp(GIT + String.raw`restore\b`, 'i'),
  new RegExp(GIT + String.raw`reset\b.*--hard`, 'i'),
  new RegExp(GIT + String.raw`clean\b.*\s-\w*f`, 'i'),
  new RegExp(GIT + String.raw`stash\b(?!\s+(?:list|show)\b)`, 'i'),
]

export function dangerousCommand(command: string | null | undefined): boolean {
  return !!command && DANGEROUS.some(r => r.test(command))
}
