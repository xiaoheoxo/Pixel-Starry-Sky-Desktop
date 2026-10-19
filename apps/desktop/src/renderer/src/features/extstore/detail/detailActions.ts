import { compareExtVersion, satisfiesEngine } from '@pixelsky/protocol'
import type {
  ExtPackInfo,
  ExtStoreLocal,
  ExtStoreReportInput,
  ExtStoreReportReason,
  ExtStoreUpdate,
} from '@pixelsky/protocol'

// 商店详情页的纯函数：右上角按钮怎么算、举报表单能不能提交。不碰 window（docs/ui/extension-store-client.md §2.2）

export type DetailActionId = 'install' | 'update' | 'rollback' | 'uninstall' | 'enable' | 'disable'

/** 按钮灰掉的原因（界面按 kind 取文案） */
export type DetailReason = { kind: 'engineNeed'; version: string } | { kind: 'blocked' } | { kind: 'busy' }

export interface DetailAction {
  id: DetailActionId
  disabled: boolean
  reason?: DetailReason
  /** install / update / rollback 要装的版本 */
  version?: string
}

/** 按钮以外要写的一行说明 */
export type DetailNote = { kind: 'updateNeeds'; version: string } | { kind: 'devReplace' }

export interface DetailActions {
  actions: DetailAction[]
  notes: DetailNote[]
}

export interface DetailActionsInput {
  /** 商店里最新版和它要求的像素星空版本；详情接口 404 时是 null（没有安装按钮） */
  latest: { version: string; engineRange: string | null } | null
  /** 本机同 id 的扩展；没有是 null */
  local: Pick<ExtStoreLocal, 'source' | 'version' | 'enabled' | 'blocked'> | null
  update?: ExtStoreUpdate | null
  appVersion: string
  /** 本机有同 id 的开发版文件夹（装上后会被它替代） */
  devCopy?: boolean
  /** 这个扩展正在安装、更新或卸载 */
  busy?: boolean
}

/** 「>=0.4.0」「^0.4.0」「0.4」都取出版本号，界面上写「需要像素星空 X 以上」 */
export function engineMinVersion(range: string): string {
  const m = /(\d+(?:\.(?:\d+|x|\*)){0,2})/i.exec(range)
  return m ? m[1] : range.trim()
}

/** 当前像素星空版本不满足要求；写法认不了（null）时不拦 */
export function engineUnmet(range: string | null | undefined, appVersion: string): boolean {
  return !!range && satisfiesEngine(range, appVersion) === false
}

/**
 * 详情页右上角的按钮：
 * - 没装（含只有内置 / 开发版）：「安装」；版本要求不满足时灰掉；本机有开发版时另写「装上后会被你的开发版替代」；
 * - 已装商店版、有新版本：「更新」；新版本要求更高的像素星空时不给「更新」，写「新版本需要像素星空 X」；
 * - 已装、被平台停用、商店里有更早的可用版本（rollbackTo）：「换回 X」；
 * - 已装：「卸载」，以及「停用 / 启用」（被平台停用时「启用」灰掉）；
 * - 正在安装 / 更新 / 卸载（busy）：所有按钮灰掉。
 */
export function detailActions(input: DetailActionsInput): DetailActions {
  const { latest, local, update, appVersion, devCopy, busy } = input
  const actions: DetailAction[] = []
  const notes: DetailNote[] = []
  const busyReason: DetailReason | undefined = busy ? { kind: 'busy' } : undefined

  if (!(local?.source === 'store' && local.version !== null)) {
    if (latest) {
      const unmet = engineUnmet(latest.engineRange, appVersion)
      actions.push({
        id: 'install',
        version: latest.version,
        disabled: unmet || !!busy,
        reason: unmet ? { kind: 'engineNeed', version: engineMinVersion(latest.engineRange ?? '') } : busyReason,
      })
      if (devCopy || local?.source === 'folder') notes.push({ kind: 'devReplace' })
    }
    return { actions, notes }
  }

  const version = local.version as string
  if (update?.rollbackTo && compareExtVersion(update.rollbackTo, version) < 0) {
    actions.push({ id: 'rollback', version: update.rollbackTo, disabled: !!busy, reason: busyReason })
  } else if (update && compareExtVersion(update.latest, version) > 0) {
    if (update.engineOk === false)
      notes.push({ kind: 'updateNeeds', version: engineMinVersion(update.engineNeed ?? '') })
    else actions.push({ id: 'update', version: update.latest, disabled: !!busy, reason: busyReason })
  }
  actions.push({ id: 'uninstall', disabled: !!busy, reason: busyReason })
  if (local.enabled) actions.push({ id: 'disable', disabled: !!busy, reason: busyReason })
  else if (local.blocked) actions.push({ id: 'enable', disabled: true, reason: { kind: 'blocked' } })
  else actions.push({ id: 'enable', disabled: !!busy, reason: busyReason })
  return { actions, notes }
}

/** 本机有没有同 id 的开发中文件夹扩展 */
export const hasDevCopy = (packs: readonly Pick<ExtPackInfo, 'id' | 'source'>[], id: string): boolean =>
  packs.some(p => p.id === id && p.source === 'folder')

/** 字节数 → 「52 KB」「1.2 MB」 */
export function formatSize(bytes: number): string {
  if (!(bytes >= 0)) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

// ---- 举报 ----

export const REPORT_DETAIL_MAX = 2000

export const REPORT_REASONS: readonly ExtStoreReportReason[] = [
  'malicious',
  'broken',
  'copyright',
  'inappropriate',
  'misleading',
  'other',
]

/** 举报默认选的版本：本机装了就是本机的版本，没装就是最新版 */
export function defaultReportVersion(
  local: { version: string | null } | null | undefined,
  detail: { latest: { version: string } },
): string {
  return local?.version || detail.latest.version
}

export interface ReportDraft {
  reason: ExtStoreReportReason | null
  detail: string
  version: string
}

export type ReportProblem = 'noReason' | 'noVersion' | 'detailRequired' | 'detailTooLong'

/** 表单现在的问题；没有问题返回 null（可以提交） */
export function reportProblem(draft: ReportDraft): ReportProblem | null {
  if (!draft.reason) return 'noReason'
  if (!draft.version) return 'noVersion'
  if (draft.detail.length > REPORT_DETAIL_MAX) return 'detailTooLong'
  if (draft.reason === 'other' && !draft.detail.trim()) return 'detailRequired'
  return null
}

/** 提交给 extstore.report 的内容（先确认 reportProblem 为 null） */
export function reportInputOf(draft: ReportDraft): ExtStoreReportInput {
  return { reason: draft.reason as ExtStoreReportReason, detail: draft.detail.trim(), version: draft.version }
}
