import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { checkSvg, isExtId, isExtVersion, parseCodedError } from '@pixelsky/protocol'
import { downloadCapped } from './net'
import type { Downloaded } from './net'

// 商店图标（docs/ui/extension-store-client.md §3.9）：pixelsky-ext://store-icon/<id>/<version> 由 protocol.ts 交给这里。
// 磁盘缓存 cache/icons/<id>@<version>.png|svg（最多 500 个，最久没用的先删）；404 在内存里记 10 分钟。

export const ICON_MAX_BYTES = 256 * 1024
export const ICON_CACHE_MAX = 500
export const ICON_MISSING_TTL_MS = 10 * 60_000

export type IconMime = 'image/png' | 'image/svg+xml'
export interface StoreIcon {
  mime: IconMime
  bytes: Buffer
}
/** missing = 云端没有图标（404）；bad = 类型不对、太大或 SVG 不安全；failed = 连不上等临时失败 */
export type IconResult = { kind: 'ok'; icon: StoreIcon } | { kind: 'missing' | 'bad' | 'failed' }

const EXT_OF: Record<IconMime, string> = { 'image/png': 'png', 'image/svg+xml': 'svg' }
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface IconStoreOptions {
  dir: string
  download?: (path: string) => Promise<Downloaded>
  now?: () => number
  maxEntries?: number
  missingTtlMs?: number
}

export interface IconStore {
  get(id: string, version: string): Promise<IconResult>
  /** 卸载时删掉 <id>@* */
  remove(id: string): Promise<void>
}

/** png 要有 PNG 文件头，svg 要过 checkSvg，都不超过 256 KB */
function accept(mime: IconMime, bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.length > ICON_MAX_BYTES) return false
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(PNG_MAGIC)
  return checkSvg(bytes.toString('utf8')) === null
}

function mimeOf(header: string | null): IconMime | null {
  const type = (header ?? '').split(';')[0].trim().toLowerCase()
  return type === 'image/png' || type === 'image/svg+xml' ? type : null
}

export function createIconStore(opts: IconStoreOptions): IconStore {
  const download =
    opts.download ?? ((path: string) => downloadCapped(path, { maxBytes: ICON_MAX_BYTES, cache: 'default' }))
  const now = opts.now ?? Date.now
  const maxEntries = opts.maxEntries ?? ICON_CACHE_MAX
  const missingTtl = opts.missingTtlMs ?? ICON_MISSING_TTL_MS
  const missing = new Map<string, number>()
  const inflight = new Map<string, Promise<IconResult>>()

  const fileOf = (id: string, version: string, mime: IconMime): string =>
    join(opts.dir, `${id}@${version}.${EXT_OF[mime]}`)

  async function fromDisk(id: string, version: string): Promise<StoreIcon | null> {
    for (const mime of Object.keys(EXT_OF) as IconMime[]) {
      const file = fileOf(id, version, mime)
      let bytes: Buffer
      try {
        bytes = await readFile(file)
      } catch {
        continue
      }
      if (!accept(mime, bytes)) {
        await rm(file, { force: true }).catch(() => undefined)
        continue
      }
      const t = new Date(now())
      await utimes(file, t, t).catch(() => undefined)
      return { mime, bytes }
    }
    return null
  }

  async function prune(): Promise<void> {
    try {
      const names = await readdir(opts.dir)
      if (names.length <= maxEntries) return
      const aged = await Promise.all(
        names.map(async name => ({ name, at: (await stat(join(opts.dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
      )
      aged.sort((a, b) => a.at - b.at)
      for (const { name } of aged.slice(0, names.length - maxEntries)) await rm(join(opts.dir, name), { force: true })
    } catch {
      // 清不掉下次再清
    }
  }

  async function load(id: string, version: string): Promise<IconResult> {
    const key = `${id}@${version}`
    const until = missing.get(key)
    if (until !== undefined) {
      if (until > now()) return { kind: 'missing' }
      missing.delete(key)
    }
    const cached = await fromDisk(id, version)
    if (cached) return { kind: 'ok', icon: cached }
    let res: Downloaded
    try {
      res = await download(`/cloud/extensions/${id}/${version}/icon`)
    } catch (e) {
      const code = parseCodedError((e as Error)?.message)?.code
      if (code === 'extstore.notFound') {
        missing.set(key, now() + missingTtl)
        return { kind: 'missing' }
      }
      return { kind: code === 'extstore.tooLarge' ? 'bad' : 'failed' }
    }
    const mime = mimeOf(res.headers.get('content-type'))
    if (!mime || !accept(mime, res.bytes)) return { kind: 'bad' }
    try {
      await mkdir(opts.dir, { recursive: true })
      await writeFile(fileOf(id, version, mime), res.bytes)
      await prune()
    } catch {
      // 缓存写不进去也照样把图标给页面
    }
    return { kind: 'ok', icon: { mime, bytes: res.bytes } }
  }

  return {
    get(id, version) {
      if (!isExtId(id) || !isExtVersion(version)) return Promise.resolve({ kind: 'bad' })
      const key = `${id}@${version}`
      let p = inflight.get(key)
      if (!p) {
        p = load(id, version).finally(() => inflight.delete(key))
        inflight.set(key, p)
      }
      return p
    },
    async remove(id) {
      for (const key of [...missing.keys()]) if (key.startsWith(`${id}@`)) missing.delete(key)
      try {
        for (const name of await readdir(opts.dir)) {
          if (name.startsWith(`${id}@`)) await rm(join(opts.dir, name), { force: true })
        }
      } catch {
        // 目录不存在
      }
    },
  }
}

let shared: IconStore | null = null
/** 协议和卸载共用的那一份（缓存放在 <userData>/extension-packs/cache/icons） */
export function storeIcons(): IconStore {
  shared ??= createIconStore({ dir: join(app.getPath('userData'), 'extension-packs', 'cache', 'icons') })
  return shared
}
