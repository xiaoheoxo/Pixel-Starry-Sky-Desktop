import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkPack, codedError, compareExtVersion, EXT_LIMITS, isExtId, isExtVersion } from '@pixelsky/protocol'
import type { ExtPackInfo, ExtStoreInstallOptions, ExtStoreProgress, ExtStoreVersion } from '@pixelsky/protocol'
import { readPackZip } from '@pixelsky/extension-cli/zip'
import type { StoreApi } from './api'
import { engineNeed } from './engine'
import { keyStatus as lookupKeyStatus, type DevKeySource, type StoreKey, type StoreKeyStatus } from './keys'
import type { Downloaded } from './net'
import type { StoreHost, StoreInstallRecord, StoreTasks } from './types'
import { unpackPack } from './unpack'
import { verifyError, verifyPackage } from './verify'

// 下载、校验、解压、换上（docs/ui/extension-store-client.md §3.5）。
// 只 import type service：要改 service 状态时走构造时传进来的 host（StoreHost），见 market/types.ts。

/** 启动时对其中没装商店版的扩展静默安装；默认空，什么都不装（§11 第 4 条）。以后「首次从商店装 Material」往里加 id */
export const BOOTSTRAP_PACKS: string[] = []

/** 目录改名遇到这些错误码时按 50 / 100 / 200 / 400 ms 退避重试（杀毒软件刚扫过新写的文件时常见） */
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const BACKOFF_MS = [50, 100, 200, 400]
/** 报错里最多列几条问题 */
const SHOWN_ISSUES = 3

/** installer 用到的文件操作，测试里换成会“断电”的版本 */
export interface InstallFs {
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  writeFile(path: string, data: string): Promise<void>
  rm(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export const nodeFs: InstallFs = {
  mkdir: async path => void (await mkdir(path, { recursive: true })),
  rename,
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  rm: path => rm(path, { recursive: true, force: true }),
  exists: path =>
    access(path).then(
      () => true,
      () => false,
    ),
}

export interface InstallerDeps {
  host: StoreHost
  api: Pick<StoreApi, 'detail' | 'installed'>
  /** 限大小的下载（market/net.ts 的 downloadCapped） */
  net: {
    downloadCapped(
      path: string,
      opts: {
        maxBytes: number
        expectSize?: number
        signal?: AbortSignal
        onProgress?: (received: number, total: number | null) => void
        cache?: 'no-store'
      },
    ): Promise<Downloaded>
  }
  /** 当前站点（origin） */
  site: () => string
  /** 停用名单里有没有这个站点的这个版本；命中给原因 */
  blocked: (site: string, id: string, version: string) => { reason: string } | null
  fs?: InstallFs
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** 钥匙表和开发版钥匙来源（测试注入；不传用 market/keys.ts 的） */
  keys?: { table?: StoreKey[]; dev?: DevKeySource }
  bootstrapPacks?: string[]
  /** 进度表有变化（要推 extstore:changed）；silent 安装不触发 */
  onChange?: () => void
  log?: (message: string) => void
}

export interface InstallOptions extends ExtStoreInstallOptions {
  /** 不推进度、不弹提示，失败只写日志（仍然 reject，由调用方决定怎么处理） */
  silent?: boolean
}

export interface Installer extends StoreTasks {
  /** 安装 / 更新 / 换回：同 id 同版本重复调用拿到同一个 Promise；同 id 别的版本回 extstore.installing */
  install(id: string, version: string, options?: InstallOptions): Promise<ExtPackInfo>
  /** 取消这个 id 正在进行的任务并等它退出；没有任务时什么都不做 */
  cancel(id: string): Promise<void>
  /** 正在进行的安装（给 extstore:state） */
  installing(): Record<string, ExtStoreProgress>
  /** 启动时静默安装 BOOTSTRAP_PACKS 里没装商店版的扩展；列表为空时连 host.ready 也不等 */
  bootstrap(): Promise<void>
}

interface Task {
  version: string
  abort: AbortController
  promise: Promise<ExtPackInfo>
}

const errno = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? ''
const status404 = (e: unknown): boolean => (e as { status?: unknown })?.status === 404

/** 详情里这个版本那一项 */
function versionEntry(
  detail: { latest: ExtStoreVersion; versions: ExtStoreVersion[] },
  version: string,
): ExtStoreVersion | null {
  if (detail.latest.version === version) return detail.latest
  return detail.versions.find(v => v.version === version) ?? null
}

export function createInstaller(deps: InstallerDeps): Installer {
  const { host, api, net } = deps
  const fs = deps.fs ?? nodeFs
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const log = deps.log ?? ((message: string) => console.warn('[extension-store]', message))
  const tasks = new Map<string, Task>()
  const progress = new Map<string, ExtStoreProgress>()

  const keyStatus = (keyId: string, site: string): StoreKeyStatus | 'unknown' =>
    lookupKeyStatus(keyId, site, deps.keys?.table, deps.keys?.dev)

  async function renameRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(from, to)
        return
      } catch (e) {
        if (attempt >= BACKOFF_MS.length || !RETRY_CODES.has(errno(e))) throw e
        await sleep(BACKOFF_MS[attempt])
      }
    }
  }

  const cancelled = (): Error => codedError('extstore.cancelled')

  /** 换上：必须在 host.mutate 里调。先再查一遍（没被取消、名单、钥匙），再改名、写回执、让 service 换内存 */
  async function swapIn(task: Task, record: StoreInstallRecord, tmpDir: string): Promise<ExtPackInfo> {
    const { id, version, site } = record
    if (task.abort.signal.aborted) throw cancelled()
    const hit = deps.blocked(site, id, version)
    if (hit) throw codedError('extstore.versionBlocked', { reason: hit.reason })
    if (keyStatus(record.keyId, site) === 'revoked') throw codedError('extstore.revokedKey')

    const idDir = join(host.storeDir, id)
    const target = join(idDir, record.dir)
    await fs.mkdir(idDir)
    // 目标目录已经在（同一个包重装、上次留下的残留）：先改名挪开，失败时再换回来
    let parked: string | null = null
    if (await fs.exists(target)) {
      parked = `${target}.old-${now().toString(36)}`
      await renameRetry(target, parked)
    }
    try {
      await renameRetry(tmpDir, target)
      // install.json 先写临时文件再改名，中途断电不会留下半个回执
      const file = join(idDir, 'install.json')
      const tmp = `${file}.tmp-${process.pid}`
      await fs.writeFile(tmp, JSON.stringify(record, null, 2))
      await renameRetry(tmp, file)
    } catch (e) {
      await fs.rm(target).catch(() => undefined)
      if (parked) await fs.rename(parked, target).catch(() => undefined)
      throw e
    }
    // 旧版本目录（含 parked）不在这里删，留给下次启动的 cleanStoreDir：Windows 上目录里有文件被打开时删不掉，
    // Codex 的技能还可能指着旧目录
    return host.replaceStorePack(record, target)
  }

  async function run(id: string, version: string, options: InstallOptions, task: Task): Promise<ExtPackInfo> {
    const { signal } = task.abort
    const silent = options.silent === true
    const site = deps.site()
    const local = host.storeInfo(id)
    const kind: 'install' | 'update' = local ? 'update' : 'install'
    const setProgress = (phase: ExtStoreProgress['phase'], received: number, total: number | null): void => {
      if (silent) return
      progress.set(id, { phase, version, kind, received, total })
      deps.onChange?.()
    }
    const checkAlive = (): void => {
      if (signal.aborted) throw cancelled()
    }

    // 1. 先查
    const hit = deps.blocked(site, id, version)
    if (hit) throw codedError('extstore.versionBlocked', { reason: hit.reason })
    if (local && compareExtVersion(version, local.version) < 0 && !options.rollback)
      throw codedError('extstore.downgrade')

    let tmpDir: string | null = null
    try {
      setProgress('downloading', 0, null)
      // 2. 取详情（绕过缓存）。下架后详情 404：只靠响应头验（签名是用内置公钥验的，安全性不变）
      let entry: ExtStoreVersion | null = null
      let detailed = false
      try {
        const detail = await api.detail(id, { fresh: true, signal })
        detailed = true
        entry = versionEntry(detail, version)
      } catch (e) {
        if (!status404(e)) throw e
      }
      if (detailed && !entry) throw codedError('extstore.notFound')
      checkAlive()

      // 3. 下载（字节放在内存里，最多 10 MB）
      const downloaded = await net.downloadCapped(`/cloud/extensions/${id}/${encodeURIComponent(version)}.zip`, {
        maxBytes: EXT_LIMITS.packBytes,
        expectSize: entry?.size,
        signal,
        onProgress: (received, total) => setProgress('downloading', received, total),
        cache: 'no-store',
      })
      checkAlive()

      // 4. 校验：sha256、钥匙、签名（和详情、响应头一致）
      setProgress('verifying', downloaded.bytes.length, downloaded.bytes.length)
      const verified = verifyPackage({
        id,
        version,
        bytes: downloaded.bytes,
        headers: downloaded.headers,
        detail: entry,
        site,
        table: deps.keys?.table,
        dev: deps.keys?.dev,
      })
      if (!verified.ok) {
        log(`${id}@${version} rejected: ${verified.reason}`)
        throw verifyError(verified)
      }

      // 5. 按本机规则检查
      const src = readPackZip(downloaded.bytes)
      const check = checkPack(src, { source: 'store', appVersion: host.appVersion })
      const manifest = check.manifest
      if (check.issues.some(i => i.code === 'manifest.engineUnmet'))
        throw codedError('extstore.engineUnmet', { version: engineNeed(manifest?.engines?.pixelsky ?? '') })
      if (check.status === 'error') {
        const issues = check.issues
          .filter(i => i.severity === 'error')
          .slice(0, SHOWN_ISSUES)
          .map(i => i.message.zh)
          .join('；')
        throw codedError('extstore.packErrors', { issues })
      }
      // 正常上架的包不会有「上传时要拒收」的文件级问题（files.path / files.type / files.hidden 等，upload:'reject'）：
      // 有就说明它没走正常的检查，不装。files.unused 这类只是提示（upload:'hint'）的照装
      const fileIssues = check.issues.filter(i => i.scope === 'file' && i.upload === 'reject')
      if (fileIssues.length) {
        const files = [...new Set(fileIssues.map(i => i.path ?? i.code))].slice(0, SHOWN_ISSUES).join('、')
        throw codedError('extstore.badFiles', { files })
      }
      // §4.2 第 5 步：清单里的 id / version 必须和签过名的一样
      if (!manifest || manifest.id !== id || manifest.version !== version) {
        log(`${id}@${version} rejected: manifest says ${manifest?.id}@${manifest?.version}`)
        throw codedError('extstore.badSignature')
      }
      checkAlive()

      // 6. 解压到 store/.tmp/<随机>/
      setProgress('installing', downloaded.bytes.length, downloaded.bytes.length)
      // 启动时的 cleanStoreDir 会清空 store/.tmp：等它跑完再建临时目录（下载和校验不用等）
      await host.ready()
      checkAlive()
      tmpDir = (await unpackPack(src, host.storeDir)).dir
      checkAlive()

      // 7. 换上（排进 service 的串行队列，再查一遍）
      const record: StoreInstallRecord = {
        id,
        version,
        sha256: verified.sha256,
        size: downloaded.bytes.length,
        signature: verified.signature,
        keyId: verified.keyId,
        site,
        dir: verified.sha256.slice(0, 16),
        installedAt: now(),
      }
      const dir = tmpDir
      const info = await host.mutate(() => swapIn(task, record, dir))
      tmpDir = null // 已经改名成正式目录
      // 8. 只在新装成功后记一次安装，不等结果
      if (kind === 'install') void api.installed(id)
      return info
    } finally {
      if (tmpDir) await fs.rm(tmpDir).catch(() => undefined)
    }
  }

  function install(id: string, version: string, options: InstallOptions = {}): Promise<ExtPackInfo> {
    if (!isExtId(id) || !isExtVersion(version)) return Promise.reject(codedError('extstore.badRequest'))
    const running = tasks.get(id)
    if (running) {
      // 同 id 同版本：直接复用，不再下载（每下载一次云端加一次下载量）
      if (running.version === version) return running.promise
      return Promise.reject(codedError('extstore.installing'))
    }
    const task = { version, abort: new AbortController() } as Task
    task.promise = run(id, version, options, task)
      .catch(e => {
        if (options.silent) log(`silent install ${id}@${version} failed: ${(e as Error).message}`)
        throw e
      })
      .finally(() => {
        if (tasks.get(id) === task) tasks.delete(id)
        if (progress.delete(id)) deps.onChange?.()
      })
    tasks.set(id, task)
    return task.promise
  }

  async function cancel(id: string): Promise<void> {
    const task = tasks.get(id)
    if (!task) return
    task.abort.abort()
    await task.promise.catch(() => undefined)
  }

  async function bootstrap(): Promise<void> {
    const wanted = deps.bootstrapPacks ?? BOOTSTRAP_PACKS
    if (wanted.length === 0) return
    await host.ready()
    const have = new Set(
      host
        .packs()
        .filter(p => p.source === 'store')
        .map(p => p.id),
    )
    for (const id of wanted) {
      if (have.has(id)) continue
      try {
        const detail = await api.detail(id, { fresh: true })
        await install(id, detail.extension.version, { silent: true })
      } catch (e) {
        log(`bootstrap ${id} failed: ${(e as Error).message}`)
      }
    }
  }

  return {
    install,
    cancel,
    bootstrap,
    installing: () => Object.fromEntries(progress),
  }
}
