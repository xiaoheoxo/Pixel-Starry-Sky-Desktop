import { codedError, isExtId, isExtVersion, parseCodedError } from '@pixelsky/protocol'
import type {
  ExtPackIssue,
  ExtStoreBlockEntry,
  ExtStoreCatalogPage,
  ExtStoreCatalogQuery,
  ExtStoreCheckReport,
  ExtStoreDetail,
  ExtStoreItem,
  ExtStoreMyExtension,
  ExtStoreMyVersion,
  ExtStorePublisher,
  ExtStorePublisherState,
  ExtStoreReportInput,
  ExtStoreUploadResult,
  ExtStoreVersion,
  ExtStoreVersionStatus,
} from '@pixelsky/protocol'
import { extensionsFetch } from '../../account/account'
import { publicFetch, type FetchCache } from './net'

// 扩展商店云端接口的薄客户端（docs/ui/extension-store-client.md §7）：解析逐字段防御，snake_case → camelCase；
// 非 2xx 按「接口 + code」映射成错误键（§6.3、§6.5）。云端对照：
//   公开接口  services/cloud/internal/api/extapi/extapi.go
//   作者接口  services/cloud/internal/api/desktopapi/extensions.go
//   错误代码  services/cloud/internal/extensions/errors.go（code）、internal/api/apierr/apierr.go（状态码和中文提示）

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 调用的是哪个接口：同一个 code 在不同接口上意思不同 */
export type StoreEndpoint =
  | 'catalog'
  | 'detail'
  | 'blocklist'
  | 'installed'
  | 'publisher'
  | 'register'
  | 'upload'
  | 'withdraw'
  | 'delist'
  | 'relist'
  | 'report'

/**
 * 云端接口出错。message 是 codedError 编码（渲染层按 errors.<key> 翻译）；
 * code 是云端的英文代码（没有时为 ''），status 是 HTTP 状态码（网络错误、解析失败为 0），
 * key 是映射到的错误键，check 只在上传回 check_failed 时有
 */
export class StoreError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly key: string,
    readonly check?: ExtStoreCheckReport,
  ) {
    super(message)
    this.name = 'StoreError'
  }
}

function storeError(
  key: string,
  code: string,
  status: number,
  params?: Record<string, string | number>,
  check?: ExtStoreCheckReport,
): StoreError {
  return new StoreError(codedError(key, params).message, code, status, key, check)
}

/** 不分接口的映射 */
const ANY: Record<string, string> = {
  invalid: 'extstore.api.invalid',
  unavailable: 'extstore.api.unavailable',
}

/** 按接口的映射：key 是「接口:code」 */
const BY_ENDPOINT: Record<string, string> = {
  'upload:check_failed': 'extstore.api.checkFailed',
  'upload:check_timeout': 'extstore.api.checkTimeout',
  'upload:no_publisher': 'extstore.api.noPublisher',
  'upload:not_your_publisher': 'extstore.api.notYourPublisher',
  'upload:version_not_newer': 'extstore.api.versionProblem',
  'upload:version_used': 'extstore.api.versionProblem',
  'upload:version_pending': 'extstore.api.versionProblem',
  'upload:too_many_pending': 'extstore.api.tooManyPending',
  'upload:rate_limited': 'extstore.api.uploadRateLimited',
  'upload:too_large': 'extstore.api.tooLarge',
  'upload:bad_package': 'extstore.api.badPackage',
  'upload:checker_unavailable': 'extstore.api.checkerUnavailable',
  'upload:checker_error': 'extstore.api.checkerError',
  'report:rate_limited': 'extstore.api.reportRateLimited',
  'report:already_reported': 'extstore.api.alreadyReported',
  'report:not_found': 'extstore.api.reportNotFound',
  'register:name_taken': 'extstore.api.nameTaken',
  'register:already_publisher': 'extstore.api.alreadyPublisher',
  'register:reserved_name': 'extstore.api.reservedName',
  'register:bad_publisher_name': 'extstore.api.badPublisherName',
  'withdraw:bad_state': 'extstore.api.badState',
  'withdraw:not_found': 'extstore.api.myNotFound',
  'delist:not_found': 'extstore.api.myNotFound',
  'relist:not_found': 'extstore.api.myNotFound',
  'relist:delisted_by_admin': 'extstore.api.delistedByAdmin',
  'catalog:not_found': 'extstore.notFound',
  'detail:not_found': 'extstore.notFound',
}

/** 文案里要放云端原文的键 */
const WITH_MESSAGE = new Set(['extstore.api.versionProblem', 'extstore.api.badPackage'])

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * 把非 2xx 响应映射成错误。body 可以是任何东西（401 可能是 {"error":"invalid_token"}，也可能是空）：
 * 取 body.error（字符串，或 {message}）当云端原文，取 body.code 当代码。
 */
export function mapError(endpoint: StoreEndpoint, status: number, body: unknown): StoreError {
  let message = ''
  let code = ''
  let check: ExtStoreCheckReport | undefined
  if (isObj(body)) {
    if (typeof body.error === 'string') message = body.error
    else if (isObj(body.error) && typeof body.error.message === 'string') message = body.error.message
    code = str(body.code)
    if (code === 'check_failed' && endpoint === 'upload') check = parseCheck(body.check)
  }
  if (status === 401) return storeError('extstore.notSignedIn', code, status)
  const key = BY_ENDPOINT[`${endpoint}:${code}`] ?? ANY[code]
  if (key) {
    const params = WITH_MESSAGE.has(key) ? { message: message || `(${status})` } : undefined
    return storeError(key, code, status, params, check)
  }
  // internal 或不认识的 code：显示云端原文，没有就写状态码；5xx 没有原文时说云端暂时不可用
  if (message) return storeError('extstore.api.cloud', code, status, { message })
  if (status >= 500 && code !== 'internal') return storeError('extstore.api.unavailable', code, status)
  return storeError('extstore.api.status', code, status, { status })
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function parseItem(v: unknown): ExtStoreItem | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  const pub = isObj(v.publisher) ? v.publisher : {}
  return {
    id: v.id,
    name: str(v.name) || v.id,
    description: str(v.description),
    publisher: { name: str(pub.name), official: pub.official === true },
    version: str(v.version),
    iconUrl: str(v.icon_url),
    kinds: strList(v.kinds),
    categories: strList(v.categories),
    downloads: num(v.downloads),
    installs: num(v.installs),
    updatedAt: strOrNull(v.updated_at),
  }
}

function parseVersion(v: unknown): ExtStoreVersion | null {
  if (!isObj(v) || typeof v.version !== 'string' || !v.version) return null
  return {
    version: v.version,
    publishedAt: strOrNull(v.published_at),
    size: num(v.size),
    sha256: str(v.sha256),
    signature: str(v.signature),
    keyId: str(v.key_id),
    downloadUrl: str(v.download_url),
  }
}

const badResponse = (): StoreError => storeError('extstore.api.badResponse', '', 0)

function parseCatalog(body: unknown): ExtStoreCatalogPage {
  if (!isObj(body) || !Array.isArray(body.items)) throw badResponse()
  return {
    items: body.items.map(parseItem).filter((x): x is ExtStoreItem => x !== null),
    nextBefore: strOrNull(body.next_before),
  }
}

function parseDetail(body: unknown): ExtStoreDetail {
  if (!isObj(body)) throw badResponse()
  const extension = parseItem(body.extension)
  const latest = parseVersion(body.latest)
  if (!extension || !latest) throw badResponse()
  const contents = Array.isArray(body.contents)
    ? body.contents
        .filter((c): c is Obj => isObj(c) && typeof c.kind === 'string')
        .map(c => ({ kind: str(c.kind), count: num(c.count) }))
    : []
  return {
    extension,
    latest,
    manifest: isObj(body.manifest) ? (body.manifest as unknown as ExtStoreDetail['manifest']) : null,
    readme: str(body.readme),
    contents,
    license: strOrNull(body.license),
    repository: strOrNull(body.repository),
    homepage: strOrNull(body.homepage),
    versions: Array.isArray(body.versions)
      ? body.versions.map(parseVersion).filter((x): x is ExtStoreVersion => x !== null)
      : [],
    local: null,
  }
}

export interface ExtStoreBlocklist {
  updatedAt: string | null
  items: ExtStoreBlockEntry[]
}

function parseBlocklist(body: unknown): ExtStoreBlocklist {
  if (!isObj(body) || !Array.isArray(body.items)) throw badResponse()
  const items: ExtStoreBlockEntry[] = []
  for (const it of body.items) {
    if (!isObj(it) || typeof it.id !== 'string' || !it.id) continue
    // 版本号列表只留合法的（一个坏的不能让整条作废，把别的版本放出来）；一个合法的都没有就丢掉这条
    const versions =
      it.versions === '*' ? '*' : Array.isArray(it.versions) ? strList(it.versions).filter(isExtVersion) : null
    if (versions === null || (versions !== '*' && versions.length === 0)) continue
    items.push({ id: it.id, versions, reason: str(it.reason) })
  }
  return { updatedAt: strOrNull(body.updated_at), items }
}

const VERSION_STATUSES: readonly ExtStoreVersionStatus[] = ['pending', 'approved', 'rejected', 'withdrawn', 'blocked']

function parseMyVersion(v: unknown): ExtStoreMyVersion | null {
  if (!isObj(v) || typeof v.version !== 'string' || !v.version) return null
  return {
    version: v.version,
    status: VERSION_STATUSES.includes(v.status as ExtStoreVersionStatus)
      ? (v.status as ExtStoreVersionStatus)
      : 'pending',
    sha256: str(v.sha256),
    size: num(v.size),
    hints: num(v.hints),
    rulesVersion: num(v.rules_version),
    toolVersion: str(v.tool_version),
    blocked: v.blocked === true,
    blockReason: str(v.block_reason),
    submittedAt: strOrNull(v.submitted_at),
    reviewedAt: strOrNull(v.reviewed_at),
    rejectReason: strOrNull(v.reject_reason),
  }
}

function parseMyExtension(v: unknown): ExtStoreMyExtension | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  return {
    id: v.id,
    name: str(v.name) || v.id,
    description: str(v.description),
    kinds: strList(v.kinds),
    latestVersion: strOrNull(v.latest_version),
    downloads: num(v.downloads),
    installs: num(v.installs),
    delisted: v.delisted === true,
    delistedBy: str(v.delisted_by),
    delistReason: str(v.delist_reason),
    blocked: v.blocked === true,
    blockReason: str(v.block_reason),
    createdAt: strOrNull(v.created_at),
    updatedAt: strOrNull(v.updated_at),
    versions: Array.isArray(v.versions)
      ? v.versions.map(parseMyVersion).filter((x): x is ExtStoreMyVersion => x !== null)
      : [],
  }
}

function parsePublisher(v: unknown): ExtStorePublisher | null {
  if (!isObj(v) || typeof v.name !== 'string' || !v.name) return null
  return { name: v.name, official: v.official === true, createdAt: strOrNull(v.created_at) }
}

function parsePublisherState(body: unknown): ExtStorePublisherState {
  if (!isObj(body) || !Array.isArray(body.extensions)) throw badResponse()
  return {
    publisher: parsePublisher(body.publisher),
    extensions: body.extensions.map(parseMyExtension).filter((x): x is ExtStoreMyExtension => x !== null),
  }
}

/** 检查器的整份报告（schema 1，docs/extensions/cli.md §6.2）里软件要用的几项；形状不对返回 undefined */
export function parseCheck(v: unknown): ExtStoreCheckReport | undefined {
  if (!isObj(v) || !Array.isArray(v.issues)) return undefined
  const issues = v.issues.filter(
    (i): i is ExtPackIssue =>
      isObj(i) && typeof i.code === 'string' && isObj(i.message) && typeof i.message.zh === 'string',
  )
  const tool = isObj(v.tool) ? v.tool : {}
  const verdict = isObj(v.verdict) ? v.verdict : {}
  const counts = isObj(v.counts) ? v.counts : {}
  return {
    incomplete: false,
    issues,
    ...(typeof verdict.blocking === 'number' && { blocking: verdict.blocking }),
    ...(typeof counts.hint === 'number' && { hints: counts.hint }),
    ...(typeof tool.rulesVersion === 'number' && { rulesVersion: tool.rulesVersion }),
    ...(typeof tool.version === 'string' && { toolVersion: tool.version }),
  }
}

function parseUpload(body: unknown): ExtStoreUploadResult {
  if (!isObj(body)) throw badResponse()
  const version = parseMyVersion(body.version)
  const check = parseCheck(body.check)
  if (!version || !check) throw badResponse()
  return { version: version.version, check }
}

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

// 拼进路径的 id / 版本号先按协议包的格式规则检查（和云端一致），不合格的不发请求
function idPath(id: string): string {
  if (!isExtId(id)) throw codedError('extstore.badRequest')
  return encodeURIComponent(id)
}

function versionPath(version: string): string {
  if (!isExtVersion(version)) throw codedError('extstore.badRequest')
  return encodeURIComponent(version)
}

/** 目录每页条数（云端 limit 只能 1–100，超出回 400，不会帮忙截断） */
export const CATALOG_PAGE = 30
/** 搜索词最多 100 个字，和云端一样 */
export const QUERY_MAX_CHARS = 100

export interface StoreApiDeps {
  publicFetch: (
    path: string,
    init?: { method?: 'GET' | 'POST'; cache?: FetchCache; signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<Response>
  extensionsFetch: (
    method: 'GET' | 'POST',
    path: string,
    opts?: { body?: unknown; raw?: Uint8Array; contentType?: string; timeoutMs?: number },
  ) => Promise<Response>
}

export interface StoreApi {
  catalog(query?: ExtStoreCatalogQuery, limit?: number): Promise<ExtStoreCatalogPage>
  /** fresh：安装前、检查更新、换回时传，绕过缓存（cache:'no-cache'） */
  detail(id: string, opts?: { fresh?: boolean; signal?: AbortSignal }): Promise<ExtStoreDetail>
  blocklist(): Promise<ExtStoreBlocklist>
  /** 新装成功后记一次安装；从不抛错（404 等都不提示） */
  installed(id: string): Promise<void>
  publisher(): Promise<ExtStorePublisherState>
  register(name: string): Promise<ExtStorePublisher>
  upload(zip: Uint8Array): Promise<ExtStoreUploadResult>
  withdraw(id: string, version: string): Promise<ExtStoreMyVersion>
  delist(id: string): Promise<ExtStoreMyExtension>
  relist(id: string): Promise<ExtStoreMyExtension>
  report(id: string, input: ExtStoreReportInput): Promise<void>
}

async function bodyOf(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

export function createApi(deps: StoreApiDeps = { publicFetch, extensionsFetch }): StoreApi {
  /** 网络层的错误（连不上、超时）变成 offline / timeout；未登录、登录过期变成 notSignedIn */
  const wrap = async (endpoint: StoreEndpoint, send: () => Promise<Response>): Promise<Response> => {
    let res: Response
    try {
      res = await send()
    } catch (e) {
      if (e instanceof StoreError) throw e
      const err = e as { code?: unknown; name?: unknown; message?: unknown }
      if (err?.code === 'AUTH_EXPIRED' || (typeof err?.message === 'string' && err.message.includes('请先登录')))
        throw storeError('extstore.notSignedIn', '', 401)
      if (err?.name === 'TimeoutError') throw storeError('extstore.timeout', '', 0)
      if (err?.name === 'AbortError') throw storeError('extstore.cancelled', '', 0)
      // 已经带代码的错误（白名单拒绝、代理提示等）原样往上抛；其余网络层失败都算连不上——
      // Electron 的 net.fetch 断网时抛的是普通 Error（net::ERR_*），不是 TypeError，和 downloadCapped 一样统一成 offline
      if (e instanceof Error && parseCodedError(e.message)) throw e
      throw storeError('extstore.offline', '', 0)
    }
    if (res.ok) return res
    throw mapError(endpoint, res.status, await bodyOf(res))
  }

  const json = async (endpoint: StoreEndpoint, send: () => Promise<Response>): Promise<unknown> => {
    const res = await wrap(endpoint, send)
    try {
      return await res.json()
    } catch {
      throw badResponse()
    }
  }

  return {
    async catalog(query = {}, limit = CATALOG_PAGE) {
      const p = new URLSearchParams()
      if (query.q) p.set('q', [...query.q].slice(0, QUERY_MAX_CHARS).join(''))
      if (query.category) p.set('category', query.category)
      if (query.sort) p.set('sort', query.sort)
      if (query.before) p.set('before', query.before)
      p.set('limit', String(Math.min(100, Math.max(1, Math.trunc(limit)))))
      return parseCatalog(await json('catalog', () => deps.publicFetch(`/cloud/api/extensions?${p}`)))
    },
    async detail(id, opts = {}) {
      const path = `/cloud/api/extensions/${idPath(id)}`
      const body = await json('detail', () =>
        deps.publicFetch(path, { ...(opts.fresh && { cache: 'no-cache' as const }), signal: opts.signal }),
      )
      return parseDetail(body)
    },
    async blocklist() {
      return parseBlocklist(
        await json('blocklist', () => deps.publicFetch('/cloud/api/extensions/blocklist', { cache: 'no-cache' })),
      )
    },
    async installed(id) {
      try {
        const res = await deps.publicFetch(`/cloud/api/extensions/${idPath(id)}/installed`, { method: 'POST' })
        await res.body?.cancel().catch(() => undefined)
      } catch {
        // 计数失败不影响安装
      }
    },
    async publisher() {
      return parsePublisherState(await json('publisher', () => deps.extensionsFetch('GET', '/v1/extensions/publisher')))
    },
    async register(name) {
      const body = await json('register', () =>
        deps.extensionsFetch('POST', '/v1/extensions/publisher', { body: { name } }),
      )
      const pub = isObj(body) ? parsePublisher(body.publisher) : null
      if (!pub) throw badResponse()
      return pub
    },
    async upload(zip) {
      return parseUpload(
        await json('upload', () =>
          deps.extensionsFetch('POST', '/v1/extensions/upload', {
            raw: zip,
            contentType: 'application/zip',
            timeoutMs: 90_000,
          }),
        ),
      )
    },
    async withdraw(id, version) {
      const path = `/v1/extensions/${idPath(id)}/versions/${versionPath(version)}/withdraw`
      const body = await json('withdraw', () => deps.extensionsFetch('POST', path))
      const v = isObj(body) ? parseMyVersion(body.version) : null
      if (!v) throw badResponse()
      return v
    },
    async delist(id) {
      const path = `/v1/extensions/${idPath(id)}/delist`
      const body = await json('delist', () => deps.extensionsFetch('POST', path))
      const e = isObj(body) ? parseMyExtension(body.extension) : null
      if (!e) throw badResponse()
      return e
    },
    async relist(id) {
      const path = `/v1/extensions/${idPath(id)}/relist`
      const body = await json('relist', () => deps.extensionsFetch('POST', path))
      const e = isObj(body) ? parseMyExtension(body.extension) : null
      if (!e) throw badResponse()
      return e
    },
    async report(id, input) {
      const path = `/v1/extensions/${idPath(id)}/report`
      const res = await wrap('report', () =>
        deps.extensionsFetch('POST', path, {
          body: { reason: input.reason, detail: input.detail, version: input.version },
        }),
      )
      await res.body?.cancel().catch(() => undefined)
    },
  }
}

/** 默认实例：走真实的 publicFetch / extensionsFetch */
export const storeApi: StoreApi = createApi()
