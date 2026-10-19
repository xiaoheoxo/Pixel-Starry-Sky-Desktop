import type { ExtPackContributes, ExtPackIssue, ExtPackManifest } from './extpacks/types'

// 扩展商店（docs/ui/extension-store-client.md）：软件和云端之间的数据形状，主进程和渲染层共用。
// 字段名是软件内部的驼峰；云端接口的下划线字段由主进程 market/api.ts 解析后转成这里的形状。

/** 主进程抛 codedError 用的代码（文案在 shared/i18n/extensionCenterMessages.ts 的 errors.<代码>）；extpacks.blocked 不在这里 */
export const EXTSTORE_ERROR_CODES = [
  'extstore.notImplemented',
  'extstore.notSignedIn',
  'extstore.installing',
  'extstore.cancelled',
  'extstore.offline',
  'extstore.timeout',
  'extstore.tooLarge',
  'extstore.badSignature',
  'extstore.unknownKey',
  'extstore.unknownSite',
  'extstore.revokedKey',
  'extstore.packErrors',
  'extstore.badFiles',
  'extstore.engineUnmet',
  'extstore.downgrade',
  'extstore.versionBlocked',
  'extstore.notFound',
  'extstore.badRequest',
  'extstore.proxyHint',
  // 云端接口的错误，按「接口 + code」映射（main/extension-packs/market/api.ts）
  'extstore.api.invalid',
  'extstore.api.checkFailed',
  'extstore.api.checkTimeout',
  'extstore.api.noPublisher',
  'extstore.api.notYourPublisher',
  'extstore.api.versionProblem',
  'extstore.api.tooManyPending',
  'extstore.api.uploadRateLimited',
  'extstore.api.reportRateLimited',
  'extstore.api.alreadyReported',
  'extstore.api.reportNotFound',
  'extstore.api.myNotFound',
  'extstore.api.tooLarge',
  'extstore.api.badPackage',
  'extstore.api.checkerUnavailable',
  'extstore.api.checkerError',
  'extstore.api.unavailable',
  'extstore.api.badState',
  'extstore.api.delistedByAdmin',
  'extstore.api.nameTaken',
  'extstore.api.alreadyPublisher',
  'extstore.api.reservedName',
  'extstore.api.badPublisherName',
  'extstore.api.badResponse',
  'extstore.api.cloud',
  'extstore.api.status',
] as const
export type ExtStoreErrorCode = (typeof EXTSTORE_ERROR_CODES)[number]

/** 发现页的排序 */
export type ExtStoreSort = 'recommended' | 'downloads' | 'updated'

/** 举报原因 */
export type ExtStoreReportReason = 'malicious' | 'broken' | 'copyright' | 'inappropriate' | 'misleading' | 'other'

/** 发布者 */
export interface ExtStorePublisherRef {
  name: string
  official: boolean
}

/** 目录里的一项（云端 itemJSON） */
export interface ExtStoreItem {
  id: string
  name: string
  description: string
  publisher: ExtStorePublisherRef
  version: string
  /** 相对站点根的图标地址；没有图标时请求会 404 */
  iconUrl: string
  /** 贡献种类（grammars / themes …） */
  kinds: string[]
  categories: string[]
  downloads: number
  installs: number
  updatedAt: string | null
}

export interface ExtStoreCatalogQuery {
  q?: string
  category?: string
  sort?: ExtStoreSort
  /** 上一页返回的 nextBefore，原样传回 */
  before?: string | null
}

export interface ExtStoreCatalogPage {
  items: ExtStoreItem[]
  nextBefore: string | null
}

/** 一个上架的版本 */
export interface ExtStoreVersion {
  version: string
  publishedAt: string | null
  size: number
  sha256: string
  signature: string
  keyId: string
  /** 相对站点根的下载地址 */
  downloadUrl: string
}

/** 本机装的这份（详情和更新检查带上） */
export interface ExtStoreLocal {
  key: string
  version: string | null
  source: 'builtin' | 'folder' | 'store'
  enabled: boolean
  blocked?: { reason: string; at: string }
}

/** 详情（云端 handleDetail，另带本机装的版本） */
export interface ExtStoreDetail {
  extension: ExtStoreItem
  latest: ExtStoreVersion
  manifest: ExtPackManifest | null
  readme: string
  contents: Array<{ kind: string; count: number }>
  license: string | null
  repository: string | null
  homepage: string | null
  versions: ExtStoreVersion[]
  local: ExtStoreLocal | null
}

/** 停用名单的一项：versions 是 '*'（整个扩展）或版本号数组 */
export interface ExtStoreBlockEntry {
  id: string
  versions: '*' | string[]
  reason: string
}

export interface ExtStoreUpdate {
  latest: string
  /** 当前像素星空版本满足新版本的要求 */
  engineOk: boolean
  /** 新版本要求的像素星空版本（engineOk 为 false 时给） */
  engineNeed?: string
  /** 本机版本被停用名单命中、且商店里有更早的可用版本时给 */
  rollbackTo?: string
}

export type ExtStoreUpdates = Record<string, ExtStoreUpdate>

/** 安装进度 */
export interface ExtStoreProgress {
  phase: 'downloading' | 'verifying' | 'installing'
  version: string
  /** 'update' 包含换回 */
  kind: 'install' | 'update'
  received: number
  total: number | null
}

export interface ExtStoreState {
  /** 当前连的云端站点（origin） */
  site: string
  updates: ExtStoreUpdates
  /** 上次读到停用名单的时间（ISO）；没读到过是 null */
  blocklistAt: string | null
  installing: Record<string, ExtStoreProgress>
}

export interface ExtStoreInstallOptions {
  /** 允许装比本机低的版本（只有换回用） */
  rollback?: boolean
}

export interface ExtStoreReportInput {
  reason: ExtStoreReportReason
  detail: string
  version: string
}

/** 发布者 */
export interface ExtStorePublisher {
  name: string
  official: boolean
  createdAt: string | null
}

export type ExtStoreVersionStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'blocked'

/** 我的发布里的一个版本（云端 extVersionJSON） */
export interface ExtStoreMyVersion {
  version: string
  status: ExtStoreVersionStatus
  sha256: string
  size: number
  /** 检查提示条数 */
  hints: number
  rulesVersion: number
  toolVersion: string
  blocked: boolean
  blockReason: string
  submittedAt: string | null
  reviewedAt: string | null
  rejectReason: string | null
}

/** 我的发布里的一个扩展（云端 extExtensionJSON，附带版本列表） */
export interface ExtStoreMyExtension {
  id: string
  name: string
  description: string
  kinds: string[]
  latestVersion: string | null
  downloads: number
  installs: number
  delisted: boolean
  delistedBy: string
  delistReason: string
  blocked: boolean
  blockReason: string
  createdAt: string | null
  updatedAt: string | null
  versions: ExtStoreMyVersion[]
}

export interface ExtStorePublisherState {
  /** 没注册过发布者时是 null */
  publisher: ExtStorePublisher | null
  extensions: ExtStoreMyExtension[]
}

/** 上传检查的结果（本机检查或云端 check_failed 带回来的） */
export interface ExtStoreCheckReport {
  /** 本机没检查完（进程起不来、超时）时为 true，issues 为空 */
  incomplete: boolean
  issues: ExtPackIssue[]
  /** 要改的问题条数、只是提示的条数（云端检查报告的 verdict.blocking / counts.hint）；没有就不给 */
  blocking?: number
  hints?: number
  rulesVersion?: number
  toolVersion?: string
}

/** pickUpload 的参数：null 弹选择框；bytes 是拖进来的 zip（不接受路径） */
export type ExtStorePickUploadInput = null | { bytes: ArrayBuffer; name: string }

/** 上传前本机核对的三行 */
export interface ExtStoreUploadChecks {
  /** 需要的权限（第一期一律没有） */
  permissions: string[]
  /** id 前缀是不是自己的发布者名 */
  prefixOk: boolean
  /** 版本号是不是比已上架的都大 */
  versionNewer: boolean
}

export interface ExtStorePickUploadResult {
  /** 用一次就失效，10 分钟过期，一个窗口只留一份 */
  token: string
  id: string
  version: string
  report: ExtStoreCheckReport
  /** 这次选的包里清单的贡献（只留已知的贡献种类）；读不到是 null */
  contributes: ExtPackContributes | null
  /** 上一个上架版本的贡献（取公开详情的清单），界面拿它标出这次的新增；没上架过或取不到是 null */
  previousContributes: ExtPackContributes | null
  checks: ExtStoreUploadChecks
}

export interface ExtStoreUploadResult {
  version: string
  check: ExtStoreCheckReport
}

export interface ExtStoreRefreshResult {
  blocklistAt: string | null
}
