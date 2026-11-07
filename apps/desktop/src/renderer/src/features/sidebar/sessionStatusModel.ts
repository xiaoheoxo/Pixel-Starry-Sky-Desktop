// 侧栏对话左边那一格放什么（docs/ui/sidebar-status-icons.md §2）：一格只放一个，先后见 statusOf。纯函数，不依赖 window。
import type { ApprovalRequest, QueueSummary } from '@pixelsky/protocol'
import type { SessionPr } from '../../../../shared/types/session-status'
import { DEFAULT_PR_DISPLAY, type PrDisplay } from './prDisplay'
import type { MachineInfo } from '../../../../shared/types/machines'
import type { TranslationKey } from '@/i18n/core'
import { classifyError, type ErrorKind } from '@/features/session/live/errorKind'
import { canAnswerInline, canResume } from '@/features/panel/inbox/inboxModel'
import type { SessionLane } from '@/features/board/sessionLanes'

export type StatusKind =
  | 'approve'
  | 'question'
  | 'auth'
  | 'balance'
  | 'route'
  | 'busy'
  | 'failed'
  | 'folder'
  | 'offline'
  | 'paused'
  | 'limit'
  | 'running'
  | 'unread'
  | 'pr-conflict'
  | 'pr'

export type LabelTone = 'warn' | 'danger' | 'muted'

/** 右边写字（代替时间）的问题类；running / unread / pr 没有字 */
const LABEL: Partial<Record<StatusKind, { key: TranslationKey; tone: LabelTone }>> = {
  approve: { key: 'sidebar.tree.tag.waiting', tone: 'warn' },
  question: { key: 'sidebar.tree.tag.waiting', tone: 'warn' },
  auth: { key: 'sidebar.tree.tag.auth', tone: 'danger' },
  balance: { key: 'sidebar.tree.tag.balance', tone: 'danger' },
  route: { key: 'sidebar.tree.tag.route', tone: 'danger' },
  busy: { key: 'sidebar.tree.tag.busy', tone: 'warn' },
  failed: { key: 'sidebar.tree.tag.failed', tone: 'danger' },
  folder: { key: 'sidebar.tree.tag.folder', tone: 'danger' },
  offline: { key: 'sidebar.tree.tag.offline', tone: 'warn' },
  paused: { key: 'sidebar.tree.tag.paused', tone: 'muted' },
  // 右边写的是剩余时间（StatusLabel 按 limitAt 画），这个词条只当没有时间时的兜底
  limit: { key: 'sidebar.tree.tag.limit', tone: 'warn' },
}

/** 有字的问题类（悬停卡只给这些和 PR 弹） */
export const isProblem = (kind: StatusKind | null): boolean => !!kind && kind in LABEL
export const isPrKind = (kind: StatusKind | null): kind is 'pr' | 'pr-conflict' =>
  kind === 'pr' || kind === 'pr-conflict'

export const PR_STATE = {
  open: 'sidebar.status.pr.open',
  draft: 'sidebar.status.pr.draft',
  merged: 'sidebar.status.pr.merged',
  closed: 'sidebar.status.pr.closed',
} as const satisfies Record<SessionPr['state'], TranslationKey>

/** 已关闭的 PR 过了 7 天悬停卡里也不再列 */
export const CLOSED_PR_DAYS = 7

/** 主进程也不推过期的已关闭 PR；这里再过滤一次，免得界面一直开着时它还挂着 */
export function visiblePrs(prs: readonly SessionPr[] | undefined, now = Date.now()): SessionPr[] {
  return (prs ?? []).filter(pr => {
    if (pr.state !== 'closed' || !pr.closedAt) return true
    const at = Date.parse(pr.closedAt)
    return Number.isNaN(at) || now - at <= CLOSED_PR_DAYS * 86_400_000
  })
}

/** 开着的 PR 要不要你处理：检查没过或有冲突 */
export const prNeedsAttention = (pr: SessionPr): boolean =>
  !pr.unknown && pr.state === 'open' && (pr.ci === 'fail' || pr.conflict)

/** 图标被哪条规则藏起来了（没藏是 null）：悬停卡里写明 */
export function prIconHidden(
  pr: SessionPr,
  display: Pick<PrDisplay, 'hiddenPrs' | 'doneDays' | 'openMode'>,
  now = Date.now(),
): 'hidden' | 'expired' | 'quiet' | null {
  if (display.hiddenPrs.includes(pr.url.toLowerCase())) return 'hidden'
  if (pr.state === 'merged' || pr.state === 'closed') {
    if (display.doneDays === -1) return null
    const at = pr.closedAt ? Date.parse(pr.closedAt) : NaN
    return !Number.isNaN(at) && now - at <= display.doneDays * 86_400_000 ? null : 'expired'
  }
  return display.openMode === 'attention' && !prNeedsAttention(pr) ? 'quiet' : null
}

/** 侧栏要出图标的 PR（按「最需要看」的先后）：去掉隐藏的、合并 / 关闭过了显示期的、按设置不显示的开着的 */
export function iconPrs(
  prs: readonly SessionPr[] | undefined,
  display: PrDisplay | undefined,
  sessionId: string | undefined,
  now = Date.now(),
): SessionPr[] {
  const list = visiblePrs(prs, now)
  display ??= DEFAULT_PR_DISPLAY
  if (sessionId && display.hiddenSessions.includes(sessionId)) return []
  return list.filter(pr => !prIconHidden(pr, display, now))
}

export interface StatusInput {
  /** 看板里的卡片（lane、请求、错误）；没有就是没有要处理的 */
  card?: { lane: SessionLane; request: ApprovalRequest | null; error: string | null } | null
  /** 真在跑（会话行的状态） */
  running: boolean
  /** 新回复没看 */
  unread: boolean
  folderMissing?: boolean
  /** 对话所在的机器；只有 ssh / wsl 且断开 / 出错才算「连不上」 */
  machine?: Pick<MachineInfo, 'kind' | 'status'> | null
  prs?: readonly SessionPr[]
  /** 对话里只是提到过的 PR 链接数（不出图标，悬停卡里列） */
  mentioned?: number
  /** PR 图标显示哪些（prDisplay.ts）；不传用默认（合并、关闭后 1 天，开着的都显示） */
  display?: PrDisplay
  sessionId?: string
  /** 在等限流 / 额度恢复后自动继续：下一次继续的时间点（毫秒，QueueSummary.limitAt） */
  limitAt?: number | null
  now?: number
}

export interface SessionStatus {
  mark: StatusKind | null
  label: { key: TranslationKey; tone: LabelTone } | null
  /** 要出图标的、最需要看的 PR（iconPrs 的第一个） */
  pr: SessionPr | null
  /** PR 图标放右边（字 / 时间前面）；左边格子不放 PR */
  prInline: boolean
  /** 有 PR（含隐藏了图标的、只是提到的）：整行悬停能弹 PR 卡，在卡里恢复显示 */
  hasPrs: boolean
  /** mark 是 limit 时，下一次自动继续的时间点 */
  limitAt: number | null
}

/**
 * 出错的会话按错误原因分图标；归不了类的就是 failed（上下文超限没有单独的图标，也算 failed）。
 * 这里只有卡片摘要里的错误文字、没有 NoticeError：对话里的错误卡片可能按引擎给的结构化 kind 归类
 * （见 live/errorKind.ts 的 classifyError），侧栏只能按文字猜——两处偶尔不一致是预期的，别在这里补结构化数据流
 */
export const errorKindOf = (error: string | null | undefined): Exclude<ErrorKind, 'overflow'> | 'failed' => {
  const kind = error ? classifyError(error) : null
  return kind && kind !== 'overflow' ? kind : 'failed'
}

/**
 * 先后（一格只放一个）：approve / question > limit（在等额度恢复，报错已经由它接手）> auth / balance / route / failed / folder > busy / offline
 * > paused > running > unread。PR 不占左边格子，图标一律放右边（prInline）
 */
export function statusOf(input: StatusInput): SessionStatus {
  const { card } = input
  const pr = iconPrs(input.prs, input.display, input.sessionId, input.now)[0] ?? null
  const error = card?.lane === 'failed' ? errorKindOf(card.error) : null
  const offline =
    !!input.machine &&
    input.machine.kind !== 'local' &&
    (input.machine.status === 'disconnected' || input.machine.status === 'error')
  let mark: StatusKind | null = null
  if (card?.lane === 'waiting') {
    const kind = card.request?.kind
    mark = kind === 'command' || kind === 'file_change' || kind === 'tool' ? 'approve' : 'question'
  } else if (input.limitAt) mark = 'limit'
  else if (error && error !== 'busy') mark = error
  else if (input.folderMissing) mark = 'folder'
  else if (error === 'busy') mark = 'busy'
  else if (offline) mark = 'offline'
  else if (card?.lane === 'paused') mark = 'paused'
  else if (input.running) mark = 'running'
  else if (input.unread || card?.lane === 'unread') mark = 'unread'
  return {
    mark,
    label: (mark && LABEL[mark]) || null,
    pr,
    prInline: !!pr,
    hasPrs: !!pr || visiblePrs(input.prs, input.now).length > 0 || (input.mentioned ?? 0) > 0,
    limitAt: mark === 'limit' ? (input.limitAt ?? null) : null,
  }
}

/** 悬停卡讲什么：问题类讲问题；有 PR（图标藏了的、只是提到的也算）讲 PR；其余不弹 */
export function topicOf(status: SessionStatus): StatusKind | null {
  if (isProblem(status.mark)) return status.mark
  return status.hasPrs ? 'pr' : null
}

/** 悬停卡里的按钮（最多三个，再加「打开对话」）；具体怎么做由卡片组件接 */
export type CardActionId =
  | 'allow'
  | 'deny'
  | 'resume'
  | 'archive'
  | 'reconnect'
  | 'retry'
  | 'open-menu'
  | 'use-self'
  | 'use-platform'
  | 'open-account'
  | 'sign-in'
  | 'edit-provider'
  | 'refresh'

export const MAX_CARD_ACTIONS = 3

export function cardActions(
  topic: StatusKind,
  context: {
    request: ApprovalRequest | null
    queue: QueueSummary | null
    /** NoticeActions 的 actionsFor(kind, record, engine) 的结果；调用方算好传进来 */
    errorActions: readonly CardActionId[]
  },
): CardActionId[] {
  const list: CardActionId[] = []
  if (topic === 'approve') {
    if (canAnswerInline(context.request)) {
      list.push('allow')
      if (context.request.canDeny !== false) list.push('deny')
    }
  } else if (topic === 'auth' || topic === 'balance' || topic === 'route' || topic === 'busy' || topic === 'failed') {
    // 繁忙 / 归不了类的先给「重试」（和对话里的错误卡片一样放最前）；登录 / 余额 / 线路要先处理好才有得重试
    if (topic === 'busy' || topic === 'failed') list.push('retry')
    list.push(...context.errorActions.filter(a => a !== 'retry').slice(0, 2))
  } else if (topic === 'folder') list.push('archive')
  else if (topic === 'offline') list.push('reconnect')
  else if (topic === 'paused') {
    if (canResume(context.queue)) list.push('resume')
  } else if (isPrKind(topic)) list.push('refresh') // 打开、复制、隐藏在每个 PR 那一行上
  return list.slice(0, MAX_CARD_ACTIONS)
}

/** CI 没过：开着且 ci 为 fail 才在图标右下角加小红点；通过 / 进行中 / 没有都不加 */
export const ciFailed = (pr: SessionPr | null): boolean =>
  !!pr && !pr.unknown && pr.state === 'open' && pr.ci === 'fail'
