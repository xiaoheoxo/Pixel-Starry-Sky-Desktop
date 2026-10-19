import { issueOutcome } from '@pixelsky/protocol'
import type {
  ExtPackContributionKind,
  ExtPackContributes,
  ExtPackIssue,
  ExtStoreCheckReport,
  ExtStoreMyExtension,
  ExtStoreMyVersion,
  ExtStorePublisherState,
  ExtStoreUploadChecks,
  ExtStoreVersionStatus,
} from '@pixelsky/protocol'
import { maskEmail } from '@/features/model-channels/channelLabels'
import type { TranslationKey } from '@/i18n/core'

// 「我的发布」页签的纯函数：邮箱打码、版本状态、按钮规则、检查结果分组、上传核对、定时刷新。不碰 window

/** 上传包的大小上限（和云端、主进程一致） */
export const MAX_ZIP_BYTES = 10 * 1024 * 1024
/** 有待审核的版本时，页面开着每隔这么久刷新一次 */
export const POLL_MS = 120_000

/** 「xiao•••@qq.com」：只露第一个字 */
export const maskedEmail = (email: string | null | undefined): string => (email ? maskEmail(email) : '')

export const VERSION_STATUS_KEY = {
  pending: 'extstore.publish.version.pending',
  approved: 'extstore.publish.version.approved',
  rejected: 'extstore.publish.version.rejected',
  withdrawn: 'extstore.publish.version.withdrawn',
  blocked: 'extstore.publish.version.blocked',
} as const satisfies Record<ExtStoreVersionStatus, TranslationKey>

export type StatusTone = 'warn' | 'good' | 'danger' | 'neutral'

export function versionTone(status: ExtStoreVersionStatus): StatusTone {
  switch (status) {
    case 'pending':
      return 'warn'
    case 'approved':
      return 'good'
    case 'rejected':
    case 'blocked':
      return 'danger'
    default:
      return 'neutral'
  }
}

/** 版本后面的原因：未通过写审核原因，已停用写停用原因，其余没有 */
export function versionReason(v: ExtStoreMyVersion): string {
  if (v.status === 'rejected') return v.rejectReason ?? ''
  if (v.status === 'blocked' || v.blocked) return v.blockReason
  return ''
}

/** 只有待审核的版本能撤回 */
export const canWithdraw = (v: ExtStoreMyVersion): boolean => v.status === 'pending'

/** 平台下架的扩展作者不能自己重新上架（云端回 403 delisted_by_admin） */
export const delistedByAdmin = (e: ExtStoreMyExtension): boolean => e.delisted && e.delistedBy === 'admin'

export interface ExtensionActions {
  delist: boolean
  relist: boolean
}

export function extensionActions(e: ExtStoreMyExtension): ExtensionActions {
  return { delist: !e.delisted, relist: e.delisted && !delistedByAdmin(e) }
}

/** 已上架的最高版本：优先 latestVersion，没有就取已上架（approved）的最后一个 */
export function liveVersion(e: ExtStoreMyExtension): string | null {
  if (e.latestVersion) return e.latestVersion
  const live = e.versions.filter(v => v.status === 'approved')
  return live.length ? live[live.length - 1].version : null
}

export const hasPending = (state: ExtStorePublisherState | null | undefined): boolean =>
  !!state?.extensions.some(e => e.versions.some(v => v.status === 'pending'))

/** 有待审核时 120000，否则 null（不用刷新） */
export const pollDelay = (state: ExtStorePublisherState | null | undefined): number | null =>
  hasPending(state) ? POLL_MS : null

/** 按 pollDelay 排一次刷新；返回取消函数。状态变了（刷新回来）由调用方重新排 */
export function schedulePoll(
  state: ExtStorePublisherState | null | undefined,
  refresh: () => void,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis,
): () => void {
  const delay = pollDelay(state)
  if (delay === null) return () => {}
  const id = timers.setTimeout(refresh, delay)
  return () => timers.clearTimeout(id)
}

export type IssueGroupKey = 'reject' | 'hint' | 'note'
export const ISSUE_GROUP_KEYS: IssueGroupKey[] = ['reject', 'hint', 'note']
export const ISSUE_GROUP_TITLE = {
  reject: 'extstore.publish.report.reject',
  hint: 'extstore.publish.report.hint',
  note: 'extstore.publish.report.note',
} as const satisfies Record<IssueGroupKey, TranslationKey>

/** 检查结果分成「要改的 / 建议 / 提示」三组 */
export function groupIssues(issues: ExtPackIssue[]): Record<IssueGroupKey, ExtPackIssue[]> {
  const out: Record<IssueGroupKey, ExtPackIssue[]> = { reject: [], hint: [], note: [] }
  for (const i of issues) out[issueOutcome(i)].push(i)
  return out
}

/** 会被拒绝的条数：云端报告带了 blocking 就用它，否则数 reject */
export const rejectCount = (r: ExtStoreCheckReport): number => r.blocking ?? groupIssues(r.issues).reject.length

/** 三行核对里没过的行 */
export const failedChecks = (c: ExtStoreUploadChecks): Array<'prefix' | 'version'> => [
  ...(c.prefixOk ? [] : (['prefix'] as const)),
  ...(c.versionNewer ? [] : (['version'] as const)),
]

/** 提交审核按钮：有会被拒绝的项、或前缀 / 版本号没过时变灰；本机没检查完能点（旁边写明会占额度） */
export function canSubmit(report: ExtStoreCheckReport, checks: ExtStoreUploadChecks): boolean {
  if (failedChecks(checks).length > 0) return false
  return report.incomplete || rejectCount(report) === 0
}

export const CONTENT_KIND_ORDER: ExtPackContributionKind[] = [
  'grammars',
  'themes',
  'snippets',
  'iconThemes',
  'taskTemplates',
  'skills',
  'prompts',
]

export interface ContentRow {
  kind: ExtPackContributionKind
  count: number
  /** 上一个上架版本里没有这一种（没上架过就全算新增） */
  isNew: boolean
}

/** 「包含什么」：每种贡献的数量，上一个上架版本没有的标新增 */
export function contentRows(
  contents: ExtPackContributes | null | undefined,
  previous: ExtPackContributes | null | undefined,
): ContentRow[] {
  const rows: ContentRow[] = []
  for (const kind of CONTENT_KIND_ORDER) {
    const count = contents?.[kind]?.length ?? 0
    if (count > 0) rows.push({ kind, count, isNew: !((previous?.[kind]?.length ?? 0) > 0) })
  }
  return rows
}

export type DropResult = { ok: true; bytes: ArrayBuffer; name: string } | { ok: false; reason: 'tooLarge' | 'notZip' }

/** 读拖进来的文件：不是 .zip 或超过 10 MB 直接拒绝，不读内容 */
export async function readDroppedZip(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<DropResult> {
  if (!/\.zip$/i.test(file.name)) return { ok: false, reason: 'notZip' }
  if (file.size > MAX_ZIP_BYTES) return { ok: false, reason: 'tooLarge' }
  return { ok: true, bytes: await file.arrayBuffer(), name: file.name }
}
