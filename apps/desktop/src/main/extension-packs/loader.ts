import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { checkPack, computeLive, dedupeIssues, EXT_MANIFEST, packStatus } from '@pixelsky/protocol'
import type { ExtPackFiles, ExtPackInfo, ExtPackIssue, ExtPackOptions, ExtPackSource } from '@pixelsky/protocol'
import { FOLDER_SCAN, folderPackFiles } from '@pixelsky/extension-cli/folder'

export interface LoadedPack {
  info: ExtPackInfo
  root: string
  /** 正斜杠相对路径 → 字节数；只含普通文件（符号链接不在里面，所以永远读不到、也不会被服务） */
  files: Map<string, number>
}

export interface LoadPackInput {
  key: string
  root: string
  source: ExtPackSource
  enabled: boolean
  addedAt: number
  options: ExtPackOptions
  revision: number
  appVersion: string
  /** 是否扫 SVG 内容；不传按来源默认（内置不扫、其余扫）。商店扩展装的时候已经扫过，启动加载传 false */
  scanSvg?: boolean
}

/**
 * 扩展的稳定标识，也是资源地址的主机名（所以必须是合法的小写主机名）。
 * 内置：b-<清单 id>；商店：s-<清单 id>（id 本身就是合法的小写主机名）；文件夹：f-<绝对路径规范化后 sha1 的前 12 位十六进制>，
 * 路径只在大小写不敏感的系统（win32 / darwin）上转小写，Linux 区分大小写。
 * platform 只给测试用，默认是当前系统。
 */
export function packKey(source: ExtPackSource, rootOrId: string, platform: NodeJS.Platform = process.platform): string {
  if (source === 'builtin') return `b-${rootOrId.toLowerCase()}`
  if (source === 'store') return `s-${rootOrId.toLowerCase()}`
  let path = platform === 'win32' ? rootOrId.replace(/\//g, '\\') : rootOrId
  if (path.length > 1) path = path.replace(/[\\/]+$/, '')
  if (platform === 'win32' || platform === 'darwin') path = path.toLowerCase()
  return `f-${createHash('sha1').update(path).digest('hex').slice(0, 12)}`
}

/** 内置扩展随包发行、文件多（Material 图标上千个），扫描上限放宽 */
const BUILTIN_SCAN = { limitFiles: 20_000, limitBytes: 200 * 1024 * 1024 }

/**
 * 各来源的扫描上限：内置放宽，商店和文件夹同一档（FOLDER_SCAN）。
 * 以后 Material 商店版有 1255 个文件，可能超过文件夹的上限，搬家时再定（ext-store-step7-plan 风险 7）
 */
export function scanLimits(source: ExtPackSource): { limitFiles: number; limitBytes: number } {
  return source === 'builtin' ? BUILTIN_SCAN : FOLDER_SCAN
}

/**
 * 加载一个扩展：交给协议包的 checkPack（清单 → 文件表 → 文件检查 → 内容检查），
 * 这里只做文件夹遍历和 ExtPackInfo 组装；永远不抛错，问题都记在 info.issues 里。
 * 有 scope:'pack' 错误的扩展 status 为 error，live 为 false，贡献内容一个都不用。
 */
export async function loadPack(input: LoadPackInput): Promise<LoadedPack> {
  const { key, root, source, enabled, addedAt, options, revision, appVersion } = input
  let src: ExtPackFiles
  try {
    src = await folderPackFiles(root, scanLimits(source))
  } catch {
    src = { entries: [], truncated: false, stat: () => null, read: () => null }
  }
  const c = checkPack(src, { source, appVersion, scanSvg: input.scanSvg })
  const info: ExtPackInfo = {
    key,
    id: c.id,
    source,
    path: root,
    enabled,
    addedAt,
    revision,
    status: c.status,
    manifest: c.manifest,
    live: computeLive({ enabled, status: c.status }),
    inactive: c.inactive,
    issues: c.issues,
    options,
    skills: c.skills,
  }
  return { info, root, files: c.files }
}

/** 给已加载的扩展追加一个问题（如重复 id）并重算状态 */
export function addPackIssue(pack: LoadedPack, issue: ExtPackIssue): void {
  const info = pack.info
  info.issues = dedupeIssues([...info.issues, issue])
  info.status = packStatus(info.issues)
  info.live = computeLive(info)
}

/** 清单文件是否存在（addFolder 的前置检查，不读内容） */
export const hasManifest = (root: string): boolean => existsSync(join(root, EXT_MANIFEST))
