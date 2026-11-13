// 概况面板的纯逻辑（docs/ui/session-overview-impl.md）
import type { ApprovalRequest, ContextWindow, Item, McpReport, McpOpKind, TurnUsage } from '@pixelsky/protocol'
import { tr } from '@/i18n/core'
import { isTurnUser, type TurnChanges, type TurnFile } from '@/features/coding/ai/turnChangesModel'
import { contextLabel, contextPercentage } from '@/features/session/contextData'
import { approvalSummary, isSolo } from '@/features/session/live/approvals/model'
import { turnKey } from '@/features/session/live/progressData'
import {
  percentText,
  resetFull,
  WARN_PERCENT,
  type QuotaEntry,
  type QuotaLayout,
  type QuotaLevel,
} from '@/features/session/quota/quotaModel'
import { PR_STATE, prNeedsAttention } from '@/features/sidebar/sessionStatusModel'
import { checkProblems, type CheckRun } from '../../../../../shared/types/checks'
import type { GitCode, GitStatus } from '../../../../../shared/types/project-tools'
import type { SessionPr } from '../../../../../shared/types/session-status'
import { displayName, type Connector, type ConnectorStatus } from '../connectors/connectorsModel'
import { checkAttentionKey } from './attentionDismissed'

export interface OverviewPrefs {
  collapsed: string[]
  hidden: string[]
}

export const DEFAULT_OVERVIEW_PREFS: OverviewPrefs = { collapsed: [], hidden: [] }

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : null

export function parseOverviewPrefs(raw: unknown): OverviewPrefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_OVERVIEW_PREFS
  const v = raw as Record<string, unknown>
  return {
    collapsed: strings(v.collapsed) ?? DEFAULT_OVERVIEW_PREFS.collapsed,
    hidden: strings(v.hidden) ?? DEFAULT_OVERVIEW_PREFS.hidden,
  }
}

/** 进度卡片要不要停靠到概况：右栏开着、这个会话是当前窗格的、右栏选中概况。右栏只跟当前窗格，所以最多一份停靠 */
export function dockTarget<T>(o: {
  panelOpen: boolean
  focused: boolean
  tab: string | null
  slot: T | null
}): T | null {
  return o.panelOpen && o.focused && o.tab === 'overview' ? o.slot : null
}

/** 最近一轮的总用时：断线重连的「继续」不算新的一轮，这一轮可能有好几条 turn_stats */
export function lastTurnDuration(items: Item[]): number {
  const start = turnKey(items)
  let total = 0
  for (let i = items.length - 1; i >= 0 && items[i].id !== start; i--) {
    const item = items[i]
    if (item.kind === 'turn_stats') total += item.usage.durationMs ?? 0
  }
  return total
}

/** 上下文的颜色：80 橙（和输入框的圆环一样），90 红（快满了） */
export const contextLevel = (percent: number): QuotaLevel =>
  percent >= 90 ? 'full' : percent >= WARN_PERCENT ? 'warn' : 'normal'

/** 上下文各类占用。有诊断（Claude）按类，大的在前，不列预留和空闲；其它引擎只有最近一次请求的计数。没报的、0 的不显示 */
export function contextRows(context: ContextWindow): { name: string; tokens: number }[] {
  if (context.diagnostic)
    return context.diagnostic.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .map(c => ({ name: contextLabel(c.name), tokens: c.tokens }))
      .sort((a, b) => b.tokens - a.tokens)
  return [
    { name: tr('session.contextData.uncachedInput'), tokens: context.input ?? 0 },
    { name: tr('session.contextData.cacheRead'), tokens: context.cacheRead ?? 0 },
    { name: tr('session.contextData.cacheWrite'), tokens: context.cacheWrite ?? 0 },
    { name: tr('session.live.SessionStrips.output'), tokens: context.output ?? 0 },
  ].filter(r => r.tokens > 0)
}

export interface UsageRow {
  id: string
  name: string
  /** null 没有条（余额、点数） */
  percent: number | null
  level: QuotaLevel
  value: string
  hover?: string
}

/** 额度弹窗的卡片和小列表摊成一列（样稿：名字 + 数值 + 细条）；算不出数值的余额不显示 */
export function quotaRows(layout: QuotaLayout): UsageRow[] {
  const cards = layout.cards
    .filter(c => c.value !== '—')
    .map(c => ({
      id: c.id,
      name: c.name,
      percent: c.type === 'meter' ? c.percent : null,
      level: c.level,
      value:
        c.type === 'meter'
          ? [c.value, c.note].filter(Boolean).join(' · ')
          : [c.value, c.unit].filter(Boolean).join(' '),
      hover: c.hover,
    }))
  return [...cards, ...layout.rows]
}

export interface SessionUsage {
  turns: number
  /** 每轮的 Token（含缓存），小柱图用；断线重连的「继续」并进它那一轮 */
  perTurn: number[]
  /** 所有 turn_stats 并成一份，交给 replyStatParts 算用时和费用（≥、≈、平台口径都由它定） */
  usage: TurnUsage
  /** 含缓存的总 Token；有哪一轮计数缺失就是 null，不显示不完整的合计 */
  tokens: number | null
}

/** sessionUsage 只看这些条目：拿来判断要不要重算 */
export const countsForUsage = (item: Item): boolean => item.kind === 'turn_stats' || isTurnUser(item)

/** 本会话累计；还没有一轮结束时 null。轮数只数开启新一轮的 user 条目：断线重连的「继续」、引导都不算 */
export function sessionUsage(items: readonly Item[]): SessionUsage | null {
  let turns = 0,
    tokens: number | null = 0,
    finished = false
  const usage: TurnUsage = { models: {}, durationMs: 0 }
  const perTurn: number[] = []
  for (const item of items) {
    if (isTurnUser(item)) {
      turns++
      perTurn.push(0)
    }
    if (item.kind !== 'turn_stats') continue
    finished = true
    if (!perTurn.length) perTurn.push(0)
    usage.durationMs += item.usage.durationMs ?? 0
    if (item.usage.settlement) usage.settlement ??= item.usage.settlement
    if (item.usage.estimate) usage.estimate ??= item.usage.estimate
    for (const [model, m] of Object.entries(item.usage.models)) {
      // 键带上条目 id：同一模型每轮分开记，哪一轮没有费用 replyStatParts 才认得出来（显示 ≥）
      usage.models[`${model}#${item.id}`] = m
      const sum = m.input + m.cacheRead + m.cacheWrite + m.output
      tokens = tokens !== null && Number.isFinite(sum) ? tokens + sum : null
      if (Number.isFinite(sum)) perTurn[perTurn.length - 1] += sum
    }
  }
  return finished ? { turns, perTurn: perTurn.filter(n => n > 0), usage, tokens } : null
}

/** 按模型合计（sessionUsage 的键是「模型#条目」），Token 多的在前；每个带一份只有它的用量，交给 replyStatParts 算费用 */
export function modelUsage(usage: TurnUsage): { model: string; tokens: number; usage: TurnUsage }[] {
  const byModel = new Map<string, { model: string; tokens: number; usage: TurnUsage }>()
  for (const [key, m] of Object.entries(usage.models)) {
    const model = key.replace(/#[^#]*$/, '')
    const row = byModel.get(model) ?? { model, tokens: 0, usage: { models: {}, durationMs: 0 } }
    row.usage.models[key] = m
    const sum = m.input + m.cacheRead + m.cacheWrite + m.output
    if (Number.isFinite(sum)) row.tokens += sum
    byModel.set(model, row)
  }
  return [...byModel.values()].sort((a, b) => b.tokens - a.tokens)
}

/** 时间窗口过了多少（0–1）：由窗口时长和恢复时间算出；时长、恢复时间不知道或已过恢复时间时 null */
export function windowElapsed(
  e: Pick<QuotaEntry, 'durationMins' | 'resetsAt' | 'expired'>,
  now: number,
): number | null {
  if (!e.durationMins || e.resetsAt === null || e.expired) return null
  const f = 1 - (e.resetsAt - now) / (e.durationMins * 60_000)
  return f >= 0 && f <= 1 ? f : null
}

/** 照现在的速度会不会在恢复前用完：fast 时 emptyIn 是还能用多久，early 是比恢复早多少（毫秒） */
export type QuotaPace = { fast: true; emptyIn: number; early: number } | { fast: false }

export function quotaPace(e: QuotaEntry, now: number): QuotaPace | null {
  const f = windowElapsed(e, now)
  // 窗口刚开始时速度不准，不算
  if (f === null || f < 0.1 || e.percent <= 0 || e.percent >= 100 || e.resetsAt === null || !e.durationMins) return null
  const elapsed = f * e.durationMins * 60_000
  const emptyIn = (elapsed * (100 - e.percent)) / e.percent
  const left = e.resetsAt - now
  return emptyIn < left ? { fast: true, emptyIn, early: left - emptyIn } : { fast: false }
}

export interface ContextSplit {
  used: number
  window: number
  /** 自动压缩预留：0 是没有诊断或自动压缩关着 */
  buffer: number
  free: number
  /** 延迟加载、还没放进上下文的工具 */
  deferred: number
}

/** 上下文分三段：已用、空闲、自动压缩预留。空闲按最新的已用算：分类可能是几分钟前统计的 */
export function contextSplit(context: ContextWindow): ContextSplit | null {
  if (context.used === null || !context.window) return null
  const sum = (kind: string): number =>
    (context.diagnostic?.categories ?? []).filter(c => c.kind === kind).reduce((n, c) => n + c.tokens, 0)
  const buffer = Math.min(sum('buffer'), Math.max(0, context.window - context.used))
  return {
    used: context.used,
    window: context.window,
    buffer,
    free: Math.max(0, context.window - context.used - buffer),
    deferred: sum('deferred'),
  }
}

export interface ChangeRow {
  /** 相对仓库根（requestGitFile 用） */
  path: string
  /** 显示的路径：相对工作区 */
  label: string
  turn: TurnFile | null
  /** 状态字母；冲突是 U */
  code: GitCode
  origPath: string | null
  conflicted: boolean
  staged: boolean
  /** git 的增删行数（暂存和没暂存的加起来）；没有就是 null */
  insertions: number | null
  deletions: number | null
}

const add = (a: number | null, b: number | null | undefined): number | null =>
  typeof b === 'number' ? (a ?? 0) + b : a

/** 改动列表的前几行：冲突在最前，再是这一轮改的。同一个文件可能又暂存又没暂存，只算一行，增删加起来 */
export function changeRows(
  status: Pick<GitStatus, 'conflicted' | 'staged' | 'unstaged' | 'untracked'>,
  turn: TurnChanges | null,
  limit = 3,
): { rows: ChangeRow[]; more: number } {
  // 小写比较：Windows 上引擎报的路径大小写可能和 git 不一样，认错了也只差一个「这一轮」标记
  const turnFiles = new Map(turn?.files.map(f => [f.path.toLowerCase(), f]))
  const rows = new Map<string, ChangeRow>()
  const areas = [
    [status.conflicted, 'conflicted'],
    [status.staged, 'staged'],
    [status.unstaged, 'unstaged'],
    [status.untracked, 'untracked'],
  ] as const
  for (const [files, area] of areas)
    for (const f of files) {
      const label = f.local ?? f.path
      const row = rows.get(f.path) ?? {
        path: f.path,
        label,
        turn: turnFiles.get(label.toLowerCase()) ?? null,
        code: area === 'conflicted' ? 'U' : f.code,
        origPath: f.origPath,
        conflicted: area === 'conflicted',
        staged: false,
        insertions: null,
        deletions: null,
      }
      if (area === 'staged') row.staged = true
      row.insertions = add(row.insertions, f.insertions)
      row.deletions = add(row.deletions, f.deletions)
      rows.set(f.path, row)
    }
  const sorted = [...rows.values()].sort(
    (a, b) => Number(b.conflicted) - Number(a.conflicted) || Number(!!b.turn) - Number(!!a.turn),
  )
  return { rows: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) }
}

/** 概况分组标题行右边的一句话；bad 用红字 */
export interface Headline {
  text: string
  bad: boolean
}

export function checkHeadline(run: CheckRun): Headline {
  if (run.status === 'running') return { text: tr('checks.running'), bad: false }
  const { failed, findings, pages } = checkProblems(run)
  const names = [...failed.map(f => f.label), ...(pages.length ? [tr('checks.page')] : [])]
  if (names.length) return { text: tr('overview.checksFailed', { names: names.join(' · ') }), bad: true }
  if (findings.length) return { text: tr('checks.findings', { count: findings.length }), bad: false }
  return {
    text: tr(run.items.some(i => i.status !== 'skipped') ? 'overview.checksPassed' : 'checks.nothing'),
    bad: false,
  }
}

/** 冲突、检查没过优先，否则状态和检查。查不到状态（unknown）时没有 */
export function prHeadline(pr: SessionPr): Headline | null {
  if (pr.unknown) return null
  if (pr.state === 'open' && pr.conflict) return { text: tr('sidebar.status.pr.conflict'), bad: true }
  if (pr.state === 'open' && pr.ci === 'fail') return { text: tr('sidebar.status.pr.ciFailAny'), bad: true }
  const ci =
    pr.state !== 'open' || !pr.ci
      ? null
      : tr(pr.ci === 'pass' ? 'sidebar.status.pr.ciPass' : 'sidebar.status.pr.ciPending')
  return { text: [tr(PR_STATE[pr.state]), ci].filter(Boolean).join(' · '), bad: false }
}

/** 这个服务现在能做哪些操作：引擎进程没在跑时（report.live 为 false）操作都会报错，引擎不支持的（report.ops）不给 */
export function mcpActions(
  status: ConnectorStatus,
  report: McpReport | null,
): { login: boolean; reconnect: boolean; toggle: boolean } {
  const can = (op: McpOpKind): boolean => !!report?.live && report.ops.includes(op)
  const login = status === 'auth' && can('login')
  return {
    login,
    // 要登录但引擎不支持在这里登录时，重连是唯一能试的
    reconnect: !login && (status === 'connected' || status === 'failed' || status === 'auth') && can('reconnect'),
    toggle: can('toggle'),
  }
}

/** 展开后列的工具：调用多的在前，其余按引擎报告的顺序；放不下的只报个数，全部在连接器页 */
export function topTools(
  c: Pick<Connector, 'tools' | 'toolCalls'>,
  limit = 4,
): { tools: Connector['tools']; more: number } {
  const sorted = [...c.tools].sort((a, b) => (c.toolCalls[b.name] ?? 0) - (c.toolCalls[a.name] ?? 0))
  return { tools: sorted.slice(0, limit), more: Math.max(0, sorted.length - limit) }
}

export const prConflictKey = (pr: SessionPr): string => `pr-conflict:${pr.url}`
const prCiKey = (pr: SessionPr): string => `pr-ci:${pr.url}`

/** 现在已经没这个问题的 PR：点过的记录要忘掉，以后再冲突、再失败还要提。查不到状态时不算解决了 */
export function resolvedPrKeys(prs: readonly SessionPr[]): string[] {
  return prs
    .filter(pr => !pr.unknown)
    .flatMap(pr => [...(pr.conflict ? [] : [prConflictKey(pr)]), ...(pr.ci === 'fail' ? [] : [prCiKey(pr)])])
}

/** 一条的主操作；额度快满没有可做的 */
export type AttentionAction =
  | { kind: 'approval'; requestId: string }
  | { kind: 'mcp-login' | 'mcp-reconnect'; name: string }
  | { kind: 'check'; run: CheckRun }
  | { kind: 'pr-conflict' | 'pr-ci'; pr: SessionPr }
  | { kind: 'compact' }

export interface AttentionItem {
  key: string
  kind: 'approval' | 'mcp' | 'check' | 'pr' | 'context' | 'quota'
  /** bad：坏了（连不上、检查没过、PR 冲突）；warn：要你处理 */
  tone: 'bad' | 'warn'
  text: string
  sub?: string
  action: AttentionAction | null
}

/** 等审批：再多也只占一行，一项项处理在对话下面的列表里。概况顶上的「正在」行显示它，「要处理」里不再列 */
export function approvalItem(pending: readonly ApprovalRequest[], cwd: string | null): AttentionItem | null {
  const first = pending[0]
  if (!first) return null
  const summary = approvalSummary(first, cwd)
  const what = isSolo(first) ? first.title : summary.text || summary.label || first.title
  const many = pending.length > 1
  return {
    key: `approval:${first.requestId}`,
    kind: 'approval',
    tone: 'warn',
    text: many ? tr('approvals.title', { n: pending.length }) : tr('overview.attentionApproval', { what }),
    sub: many ? what : undefined,
    action: { kind: 'approval', requestId: first.requestId },
  }
}

/** 到这个比例才算快满（样稿；输入框的橙色提醒是 80） */
const FULL_PERCENT = 90

/** 「要处理」：下面各分组里要你动手的，按要紧程度排 */
export function attentionItems(o: {
  pending: readonly ApprovalRequest[]
  cwd: string | null
  connectors: readonly Connector[]
  report: McpReport | null
  check: CheckRun | null
  prs: readonly SessionPr[]
  context: ContextWindow | null
  /** 最紧的一项额度（tightestEntry） */
  quota: QuotaEntry | null
  now: number
  dismissed: ReadonlySet<string>
}): AttentionItem[] {
  const items: AttentionItem[] = []
  const approval = approvalItem(o.pending, o.cwd)
  if (approval) items.push(approval)
  // 引擎进程没在跑时报告是旧的，操作也会报错
  if (o.report?.live)
    for (const c of o.connectors) {
      if (c.status !== 'auth' && c.status !== 'failed') continue
      const can = mcpActions(c.status, o.report)
      items.push({
        key: `mcp:${c.name}`,
        kind: 'mcp',
        tone: c.status === 'failed' ? 'bad' : 'warn',
        text: tr(c.status === 'auth' ? 'overview.attentionMcpAuth' : 'overview.attentionMcpFailed', {
          name: displayName(c),
        }),
        sub: c.error?.split('\n')[0],
        action: can.login
          ? { kind: 'mcp-login', name: c.name }
          : can.reconnect
            ? { kind: 'mcp-reconnect', name: c.name }
            : null,
      })
    }
  if (o.check) {
    const headline = checkHeadline(o.check)
    if (headline.bad)
      items.push({
        key: checkAttentionKey(o.check.id),
        kind: 'check',
        tone: 'bad',
        text: headline.text,
        action: { kind: 'check', run: o.check },
      })
  }
  for (const pr of o.prs) {
    if (!prNeedsAttention(pr)) continue
    items.push(
      pr.conflict
        ? {
            key: prConflictKey(pr),
            kind: 'pr',
            tone: 'bad',
            text: tr('overview.attentionPrConflict', { number: pr.number, base: pr.base }),
            action: { kind: 'pr-conflict', pr },
          }
        : {
            key: prCiKey(pr),
            kind: 'pr',
            tone: 'bad',
            text: tr('overview.attentionPrCi', { number: pr.number }),
            action: { kind: 'pr-ci', pr },
          },
    )
  }
  const percent = contextPercentage(o.context)
  // 正在压缩时比例还没降下来，不再提
  if (percent !== null && percent >= FULL_PERCENT && !o.context?.compacting)
    items.push({
      key: 'context',
      kind: 'context',
      tone: 'warn',
      text: tr('overview.attentionContext', { percent: percentText(percent) }),
      action: { kind: 'compact' },
    })
  if (o.quota && o.quota.percent >= FULL_PERCENT)
    items.push({
      key: 'quota',
      kind: 'quota',
      tone: 'warn',
      text: tr('overview.attentionQuota', { name: o.quota.label, percent: percentText(o.quota.percent) }),
      sub: o.quota.resetsAt === null ? undefined : resetFull(o.quota.resetsAt, o.now),
      action: null,
    })
  return items.filter(item => !o.dismissed.has(item.key))
}
