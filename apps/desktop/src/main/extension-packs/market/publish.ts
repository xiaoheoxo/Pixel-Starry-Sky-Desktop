import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { folderPackFiles } from '@pixelsky/extension-cli/folder'
import { readPackZip, writePackZip } from '@pixelsky/extension-cli/zip'
import {
  checkPack,
  codedError,
  compareExtVersion,
  EXT_LIMITS,
  EXT_MANIFEST,
  isExtId,
  isExtVersion,
  isPublisherName,
} from '@pixelsky/protocol'
import type {
  ExtPackContributes,
  ExtPackContributionKind,
  ExtStoreCheckReport,
  ExtStoreDetail,
  ExtStoreMyExtension,
  ExtStorePickUploadInput,
  ExtStorePickUploadResult,
  ExtStorePublisher,
  ExtStorePublisherState,
  ExtStoreReportInput,
  ExtStoreReportReason,
  ExtStoreUploadResult,
} from '@pixelsky/protocol'
import type { StoreApi } from './api'
import { StoreError } from './api'
import type { RunUploadCheck } from './check-host'

// 我的发布（docs/ui/extension-store-client.md §6）：读包、核对云端才查的规则、交给本机检查、上传、
// 把逐条检查结果存到 publish-checks/<id>@<version>.json，以及注册 / 撤回 / 下架 / 重新上架 / 举报。
// 不导入 service.ts，不碰 electron：弹选择框（pickPath）、登录状态（signedIn）、检查进程（runCheck）都从外面注入。

/** zip 最多 10 MB；读的时候多读 1 字节用来判断超了 */
export const UPLOAD_MAX_BYTES = EXT_LIMITS.packBytes
export const READ_LIMIT = UPLOAD_MAX_BYTES + 1
/** 一次上传面板里的 token 10 分钟过期 */
export const TOKEN_TTL_MS = 10 * 60_000
/** 同一个扩展最多同时有这么多个待审核版本 */
export const MAX_PENDING = 3
export const REPORT_DETAIL_MAX = 2000
const REPORT_REASONS: readonly ExtStoreReportReason[] = [
  'malicious',
  'broken',
  'copyright',
  'inappropriate',
  'misleading',
  'other',
]

export interface PublishFs {
  /** 路径是文件夹、普通文件还是别的；不存在抛错 */
  kind(path: string): Promise<'dir' | 'file' | 'other'>
  /** 只读前 limit 字节 */
  readHead(path: string, limit: number): Promise<Buffer>
  /** 文件夹 → 确定性打包 zip（和 pixelsky-ext pack 同一套：folderPackFiles + writePackZip） */
  packFolder(path: string): Promise<Buffer>
  mkdir(path: string): Promise<void>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  readFile(path: string): Promise<string>
  rm(path: string): Promise<void>
}

/** 一个窗口的标识（event.sender.id）：每个窗口只留一份没用过的 token */
export type PublishOwner = number | string

export interface PublisherDeps {
  api: Pick<StoreApi, 'publisher' | 'register' | 'upload' | 'withdraw' | 'delist' | 'relist' | 'report' | 'detail'>
  /** 本机按上传标准检查（check-host.ts 的 createCheckHost；测试用假实现） */
  runCheck: RunUploadCheck
  /** 登录了返回邮箱，没登录 null（account.ts 的 signedInEmail） */
  signedIn: () => string | null
  /** 弹选择框（zip 或文件夹），返回选中的路径；取消返回 null。路径只在主进程内部用，不来自渲染层 */
  pickPath: (owner: PublishOwner) => Promise<string | null>
  /** <userData>/extension-packs/publish-checks */
  checksDir: string
  fs?: PublishFs
  now?: () => number
  randomToken?: () => string
}

export interface Publisher {
  publisher(): Promise<ExtStorePublisherState>
  register(name: unknown): Promise<ExtStorePublisher>
  pickUpload(input: ExtStorePickUploadInput | unknown, owner: PublishOwner): Promise<ExtStorePickUploadResult | null>
  upload(token: unknown, owner: PublishOwner): Promise<ExtStoreUploadResult>
  withdraw(id: unknown, version: unknown): Promise<void>
  delist(id: unknown): Promise<void>
  relist(id: unknown): Promise<void>
  report(id: unknown, input: unknown): Promise<void>
  publishCheck(id: unknown, version: unknown): Promise<ExtStoreCheckReport | null>
  /** 这个窗口关了：丢掉它没用过的 token 和字节（最多 10 MB） */
  forget(owner: PublishOwner): void
}

export const nodeFs: PublishFs = {
  async kind(path) {
    const st = await stat(path)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
  },
  async readHead(path, limit) {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(limit)
      let got = 0
      while (got < limit) {
        const { bytesRead } = await fh.read(buf, got, limit - got, got)
        if (bytesRead === 0) break
        got += bytesRead
      }
      return buf.subarray(0, got)
    } finally {
      await fh.close()
    }
  },
  async packFolder(path) {
    const files = await folderPackFiles(path)
    const paths = [...checkPack(files, { source: 'folder', grammar: [] }).files.keys()].sort()
    return Buffer.from(writePackZip(files, paths))
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true })
  },
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  rename,
  readFile: path => readFile(path, 'utf8'),
  rm: path => rm(path, { force: true }),
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 已知的贡献种类；少一个种类这里会编译不过 */
const CONTRIBUTION_KINDS = {
  grammars: true,
  themes: true,
  snippets: true,
  iconThemes: true,
  taskTemplates: true,
  skills: true,
  prompts: true,
} satisfies Record<ExtPackContributionKind, true>

/** zip 是用户选的、不可信：只留已知的贡献种类，且值是数组的；一个都没有也回一个空对象 */
function contributesFrom(raw: unknown): ExtPackContributes | null {
  if (!isObj(raw)) return null
  const out: Record<string, unknown[]> = {}
  for (const kind of Object.keys(CONTRIBUTION_KINDS)) {
    const list = raw[kind]
    if (Array.isArray(list)) out[kind] = list
  }
  return out as ExtPackContributes
}

interface Manifest {
  id: string
  version: string
  publisher: string
  contributes: ExtPackContributes | null
}

/** 从 zip 字节里读出清单的 id / version / publisher；读不到或格式不对返回 null */
function manifestOf(zip: Buffer): Manifest | null {
  try {
    const raw = readPackZip(zip).read(EXT_MANIFEST, 1024 * 1024)
    if (!raw) return null
    const m: unknown = JSON.parse(new TextDecoder().decode(raw))
    if (!isObj(m) || !isExtId(m.id) || !isExtVersion(m.version)) return null
    return {
      id: m.id,
      version: m.version,
      publisher: typeof m.publisher === 'string' ? m.publisher : '',
      contributes: contributesFrom(m.contributes),
    }
  } catch {
    return null
  }
}

/** 读不到清单时的错误：用不花时间的静态检查挑出前 3 条要改的问题，不起检查进程 */
function unreadablePackError(zip: Buffer): Error {
  const issues = checkPack(readPackZip(zip), { source: 'folder', grammar: [] })
    .issues.filter(i => i.severity === 'error')
    .slice(0, 3)
    .map(i => i.message.zh)
  return codedError('extstore.packErrors', { issues: issues.join('；') || `${EXT_MANIFEST} 读不出来` })
}

function isReport(v: unknown): v is ExtStoreCheckReport {
  return isObj(v) && typeof v.incomplete === 'boolean' && Array.isArray(v.issues)
}

interface Pending {
  token: string
  bytes: Buffer
  id: string
  version: string
  report: ExtStoreCheckReport
  expires: number
}

export function createPublisher(deps: PublisherDeps): Publisher {
  const { api } = deps
  const fs = deps.fs ?? nodeFs
  const now = deps.now ?? Date.now
  const newToken = deps.randomToken ?? ((): string => randomBytes(16).toString('hex'))
  /** 每个窗口只留一份没用过的 token，新的顶掉旧的 */
  const pending = new Map<PublishOwner, Pending>()
  /** 每个窗口一个标记，关窗口（forget）时删掉：选包、本机检查期间窗口关了，选完对不上就不再存字节 */
  const alive = new Map<PublishOwner, object>()

  const requireSignedIn = (): void => {
    if (!deps.signedIn()) throw codedError('extstore.notSignedIn')
  }
  const idArg = (v: unknown): string => {
    if (!isExtId(v)) throw codedError('extstore.badRequest')
    return v
  }
  const versionArg = (v: unknown): string => {
    if (!isExtVersion(v)) throw codedError('extstore.badRequest')
    return v
  }

  // ---- 本机检查结果 ----
  const checkFile = (id: string, version: string): string => join(deps.checksDir, `${id}@${version}.json`)

  async function saveCheck(id: string, version: string, report: ExtStoreCheckReport): Promise<void> {
    idArg(id)
    versionArg(version)
    const file = checkFile(id, version)
    const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
    await fs.mkdir(deps.checksDir)
    try {
      await fs.writeFile(tmp, JSON.stringify(report))
      await fs.rename(tmp, file)
    } catch (e) {
      await fs.rm(tmp).catch(() => undefined)
      throw e
    }
  }

  async function readCheck(id: string, version: string): Promise<ExtStoreCheckReport | null> {
    idArg(id)
    versionArg(version)
    let text: string
    try {
      text = await fs.readFile(checkFile(id, version))
    } catch {
      return null
    }
    try {
      const v: unknown = JSON.parse(text)
      return isReport(v) ? v : null
    } catch {
      return null
    }
  }

  /** 存盘失败不能让上传本身显示成失败（包已经交给云端了） */
  const saveQuietly = (id: string, version: string, report: ExtStoreCheckReport): Promise<void> =>
    saveCheck(id, version, report).catch(() => undefined)

  // ---- 拿 zip 字节 ----
  async function zipBytes(input: unknown, owner: PublishOwner): Promise<Buffer | null> {
    if (input === null || input === undefined) {
      const path = await deps.pickPath(owner)
      if (path === null) return null
      const kind = await fs.kind(path).catch(() => 'other' as const)
      if (kind === 'other') throw codedError('extstore.badRequest')
      const bytes = kind === 'dir' ? await fs.packFolder(path) : await fs.readHead(path, READ_LIMIT)
      if (bytes.length > UPLOAD_MAX_BYTES) throw codedError('extstore.tooLarge')
      return bytes
    }
    // 传字符串（路径）一律拒绝；只收 { bytes: ArrayBuffer, name }
    if (!isObj(input) || !(input.bytes instanceof ArrayBuffer) || typeof input.name !== 'string')
      throw codedError('extstore.badRequest')
    if (input.bytes.byteLength > UPLOAD_MAX_BYTES) throw codedError('extstore.tooLarge')
    return Buffer.from(input.bytes)
  }

  const myExtension = (state: ExtStorePublisherState, id: string): ExtStoreMyExtension | undefined =>
    state.extensions.find(e => e.id === id)

  const previousContributes = async (id: string): Promise<ExtPackContributes | null> => {
    try {
      const d: ExtStoreDetail = await api.detail(id, { fresh: true })
      return d.manifest?.contributes ?? null
    } catch {
      return null // 没上架过（404）或者暂时取不到：当成都是新增
    }
  }

  return {
    async publisher() {
      requireSignedIn()
      return api.publisher()
    },

    async register(name) {
      requireSignedIn()
      if (!isPublisherName(name)) throw codedError('extstore.badRequest')
      return api.register(name)
    },

    async pickUpload(input, owner) {
      requireSignedIn()
      let mark = alive.get(owner)
      if (!mark) alive.set(owner, (mark = {}))
      const zip = await zipBytes(input, owner)
      if (zip === null) return null
      const manifest = manifestOf(zip)
      if (!manifest) throw unreadablePackError(zip)

      // 云端才查的规则：先取列表（便宜，还能提前发现没发布者），再花时间做本机检查
      const state = await api.publisher()
      if (!state.publisher) throw codedError('extstore.api.noPublisher')
      const versions = myExtension(state, manifest.id)?.versions ?? []
      if (versions.filter(v => v.status === 'pending').length >= MAX_PENDING)
        throw codedError('extstore.api.tooManyPending')

      const name = state.publisher.name
      const checks = {
        permissions: [] as string[],
        prefixOk: manifest.publisher === name && manifest.id.startsWith(`${name}.`),
        // 和云端 versionRule 一致：已通过的版本号永远不能再用、必须比已通过的最高版本大；待审核的只禁同号，
        // 不要求比它大；撤回、没通过的版本号可以再用（方案 §2.6）
        versionNewer: versions.every(v =>
          v.status === 'approved'
            ? compareExtVersion(manifest.version, v.version) > 0
            : v.status !== 'pending' || v.version !== manifest.version,
        ),
      }
      const [report, previous] = await Promise.all([deps.runCheck(zip), previousContributes(manifest.id)])

      // 核对没过、或本机检查有要改的问题时不发 token（token 为空串）：界面看到就知道不能提交，也不会白占上传额度
      const blocked = !checks.prefixOk || !checks.versionNewer || (!report.incomplete && (report.blocking ?? 0) > 0)
      let token = ''
      // 窗口在选包 / 检查期间关了：forget 已经执行过，这时再存就没人来删了
      if (blocked || alive.get(owner) !== mark) pending.delete(owner)
      else {
        token = newToken()
        // 顺手清掉所有窗口里已过期的（关窗口的 destroyed 事件之外的兜底）
        for (const [key, entry] of pending) if (entry.expires <= now()) pending.delete(key)
        pending.set(owner, {
          token,
          bytes: zip,
          id: manifest.id,
          version: manifest.version,
          report,
          expires: now() + TOKEN_TTL_MS,
        })
      }
      return {
        token,
        id: manifest.id,
        version: manifest.version,
        report,
        contributes: manifest.contributes,
        previousContributes: previous,
        checks,
      }
    },

    async upload(token, owner) {
      requireSignedIn()
      const entry = pending.get(owner)
      // token 用一次就失效：不管上传成不成功都删掉，失败后要重新选包
      pending.delete(owner)
      if (typeof token !== 'string' || !token || !entry || entry.token !== token || entry.expires <= now())
        throw codedError('extstore.badRequest')
      try {
        const result = await api.upload(entry.bytes)
        // 本机检查没跑完时没有可存的逐条结果，存云端带回来的那份
        await saveQuietly(entry.id, entry.version, entry.report.incomplete ? result.check : entry.report)
        return result
      } catch (e) {
        // 云端回 check_failed：把它带回来的报告存本机；渲染层用 publishCheck(id, version) 读回来画出来
        // （IPC 只传错误文案，传不了错误对象上的 check）
        if (e instanceof StoreError && e.code === 'check_failed' && e.check)
          await saveQuietly(entry.id, entry.version, e.check)
        throw e
      }
    },

    async withdraw(id, version) {
      requireSignedIn()
      await api.withdraw(idArg(id), versionArg(version))
    },
    async delist(id) {
      requireSignedIn()
      await api.delist(idArg(id))
    },
    async relist(id) {
      requireSignedIn()
      await api.relist(idArg(id))
    },

    async report(id, input) {
      requireSignedIn()
      const extId = idArg(id)
      if (!isObj(input)) throw codedError('extstore.badRequest')
      const { reason, detail } = input
      if (typeof reason !== 'string' || !REPORT_REASONS.includes(reason as ExtStoreReportReason))
        throw codedError('extstore.badRequest')
      if (typeof detail !== 'string' || detail.length > REPORT_DETAIL_MAX) throw codedError('extstore.badRequest')
      // 版本默认举报商店里现在的版本
      const version =
        input.version === undefined || input.version === ''
          ? (await api.detail(extId)).extension.version
          : versionArg(input.version)
      const body: ExtStoreReportInput = { reason: reason as ExtStoreReportReason, detail, version }
      await api.report(extId, body)
    },

    async publishCheck(id, version) {
      return readCheck(idArg(id), versionArg(version))
    },

    forget(owner) {
      pending.delete(owner)
      alive.delete(owner)
    },
  }
}
