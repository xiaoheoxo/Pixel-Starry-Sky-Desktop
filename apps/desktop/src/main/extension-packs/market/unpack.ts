import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  codedError,
  EXT_ALLOWED_FILE_RE,
  EXT_LICENSE_FILE_RE,
  EXT_LIMITS,
  EXT_WINDOWS_RESERVED_RE,
  resolvePackPath,
} from '@pixelsky/protocol'
import type { ExtPackFiles } from '@pixelsky/protocol'

// 解压前的文件名检查和写文件（docs/ui/extension-store-client.md §3.5 第 6 步、§8）。
// 写到 store/.tmp/<随机>/；改名换上放在 install.ts。

/** 这个路径为什么不能在本机保存；没问题返回 null（规则和协议包 validatePackFiles 的 F4 一致） */
export function badPathReason(path: string): string | null {
  if (path.length > EXT_LIMITS.pathChars) return 'too long'
  if (path.includes('\\')) return 'backslash'
  if (path.includes(':')) return 'colon'
  if (/[*?"<>|]/.test(path)) return 'windows-invalid character'
  if ([...path].some(c => c.charCodeAt(0) < 0x20)) return 'control character'
  const segs = path.split('/')
  if (segs.some(s => s === '' || s === '.' || s === '..')) return 'bad segment'
  if (segs.some(s => EXT_WINDOWS_RESERVED_RE.test(s))) return 'reserved name'
  if (segs.some(s => /[. ]$/.test(s))) return 'trailing dot or space'
  return null
}

/** 要写到磁盘的文件：不是 samples/，类型在白名单里（json / md / png / svg / txt / LICENSE*） */
function shouldWrite(path: string): boolean {
  if (path.startsWith('samples/')) return false
  const base = path.slice(path.lastIndexOf('/') + 1)
  return EXT_ALLOWED_FILE_RE.test(base) || EXT_LICENSE_FILE_RE.test(base)
}

export interface Unpacked {
  /** 解压好的临时目录（store/.tmp/<随机>） */
  dir: string
  /** 写了多少个文件 */
  files: number
}

/**
 * 把 src 里 kind === 'file' 的普通文件解到 <storeDir>/.tmp/<随机>/。
 * 危险的文件名（: 、保留名、结尾 . / 空格、只有大小写不同、逃出目录）整包拒绝，抛 extstore.badFiles（带前 3 个文件名）；
 * 符号链接条目一律不写、不读；samples/ 和白名单外的类型不写；读不到文件内容整包失败。
 * 失败时临时目录已删掉；成功后由调用方改名换上（或自己删掉）。
 */
export async function unpackPack(src: ExtPackFiles, storeDir: string): Promise<Unpacked> {
  const files = src.entries.filter(e => e.kind === 'file')
  const bad: string[] = []
  const seen = new Map<string, string>()
  for (const f of files) {
    // NFC 归一 + 小写后撞名（含完全相同的路径）都整包拒绝，免得写第二份时撞出裸 EEXIST
    const lower = f.path.normalize('NFC').toLowerCase()
    const prev = seen.get(lower)
    if (badPathReason(f.path) !== null || prev !== undefined || resolvePackPath('', f.path) !== f.path) bad.push(f.path)
    seen.set(lower, f.path)
  }
  if (bad.length) throw codedError('extstore.badFiles', { files: bad.slice(0, 3).join('、') })

  const dir = join(storeDir, '.tmp', randomBytes(8).toString('hex'))
  const root = resolve(dir)
  let written = 0
  try {
    await mkdir(dir, { recursive: true })
    for (const f of files) {
      if (!shouldWrite(f.path)) continue
      const target = resolve(root, f.path)
      if (!target.startsWith(root + sep)) throw codedError('extstore.badFiles', { files: f.path })
      const data = src.read(f.path, EXT_LIMITS.fileBytes)
      if (!data) throw codedError('extstore.badFiles', { files: f.path })
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data, { flag: 'wx' })
      written++
    }
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
  return { dir, files: written }
}
