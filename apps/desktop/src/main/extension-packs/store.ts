import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExtPackOptions } from '@pixelsky/protocol'

/** <userData>/extension-packs/state.json：文件夹扩展的列表和各扩展的开关、选项 */
export interface PackStateFile {
  version: 1
  folders: Array<{ path: string; enabled: boolean; addedAt: number; options: ExtPackOptions }>
  builtin: Record<string, { enabled: boolean; options: ExtPackOptions }>
  /** 商店扩展（store/<id>/install.json 记装了哪些，这里只存开关和选项）；旧文件没有这个字段，读成空 */
  store: Record<string, { enabled: boolean; options: ExtPackOptions }>
  /** 只在内存里：state.json 存在但读不出来（被占用等），本次运行不写回，免得拿空状态盖掉真文件 */
  unreadable?: true
}

export const emptyState = (): PackStateFile => ({ version: 1, folders: [], builtin: {}, store: {} })

function options(raw: unknown): ExtPackOptions {
  const o: ExtPackOptions = {}
  const list = (raw as { overrideBuiltin?: unknown } | null)?.overrideBuiltin
  if (Array.isArray(list)) o.overrideBuiltin = list.filter((v): v is string => typeof v === 'string')
  return o
}

/** 读 { [id]: { enabled, options } }：形状不对的项丢掉，整个字段不是对象就当空 */
function readEntries(raw: unknown, into: PackStateFile['builtin']): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const item = v as Record<string, unknown> | null
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    into[id] = { enabled: item.enabled !== false, options: options(item.options) }
  }
}

/** 把读到的内容规整成合法状态；形状不对返回 null */
function normalize(raw: unknown): PackStateFile | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  if (data.version !== 1 || !Array.isArray(data.folders)) return null
  const state = emptyState()
  for (const f of data.folders) {
    const item = f as Record<string, unknown> | null
    if (!item || typeof item.path !== 'string' || !item.path) continue
    state.folders.push({
      path: item.path,
      enabled: item.enabled !== false,
      addedAt: typeof item.addedAt === 'number' ? item.addedAt : 0,
      options: options(item.options),
    })
  }
  readEntries(data.builtin, state.builtin)
  readEntries(data.store, state.store)
  return state
}

/**
 * 文件不存在返回空状态；损坏（解析失败或形状不对）时把原文件留成 state.json.bad-<时间>，再返回空状态；
 * 读取本身出错（被占用等）不动原文件，返回标了 unreadable 的空状态（writeStateFile 会跳过它）
 */
export function readStateFile(file: string): PackStateFile {
  if (!existsSync(file)) return emptyState()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ...emptyState(), unreadable: true }
  }
  try {
    const state = normalize(JSON.parse(text))
    if (state) return state
  } catch {
    // 落到下面的备份
  }
  try {
    renameSync(file, `${file}.bad-${Date.now()}`)
  } catch {
    // 备份不了也不影响启动
  }
  return emptyState()
}

/** 先写临时文件再改名，中途掉电不会留下半个 state.json */
export function writeStateFile(file: string, data: PackStateFile): void {
  if (data.unreadable) return
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
}
