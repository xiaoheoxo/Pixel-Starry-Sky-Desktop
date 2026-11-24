// 设置 › 模型通道 › 菜单里显示的模型（ModelsSection）：各引擎的云端模型合在一起，每个模型一个上下文窗口。
// 规则：一个模型只有一个值，写给每个能跑它的引擎；读时取能跑它的引擎里第一个填了的。纯函数
import type { EngineId } from '@pixelsky/protocol'

/** 每个引擎在平台上能跑的模型（usePlatform(engine) 的目录） */
export type EngineModelLists = Partial<Record<EngineId, readonly string[]>>
/** 每个引擎设置里平台模型的窗口（contextWindows.platform） */
export type EngineWindowMaps = Partial<Record<EngineId, Readonly<Record<string, number>>>>

/** 官方工具在前；像素星空什么协议都能跑，常常只有它能跑的模型排在后面；Antigravity 只跑 Gemini 分组 */
const ORDER: readonly EngineId[] = ['claude', 'codex', 'pixel', 'omp', 'antigravity']
/** 能改上下文窗口的引擎（Antigravity 用 agy 自己的窗口，不支持） */
const WINDOW_ORDER: readonly EngineId[] = ['claude', 'codex', 'pixel', 'omp']

/** 合在一起的模型：按引擎顺序、组内顺序去重 */
export function mergedModels(lists: EngineModelLists): string[] {
  return [...new Set(ORDER.flatMap(e => lists[e] ?? []))]
}

/**
 * 能改这个模型窗口的引擎（存窗口时每个都写一份）；只有 Antigravity 能跑的为空，那一行不给填。
 * 像素星空能跑的不单独写给 omp：主进程让 omp 用像素星空那份（engine host/settings.ts），各写一份反而会不一致
 */
export function windowEngines(model: string, lists: EngineModelLists): EngineId[] {
  return WINDOW_ORDER.filter(e => lists[e]?.includes(model) && !(e === 'omp' && lists.pixel?.includes(model)))
}

/** 能跑这个模型的引擎（行里的小图标） */
export function modelEngines(model: string, lists: EngineModelLists): EngineId[] {
  return ORDER.filter(e => lists[e]?.includes(model))
}

/** 输入框显示的值：能跑它的引擎里第一个填了的；都没填是 null（各引擎自动） */
export function sharedWindow(model: string, lists: EngineModelLists, windows: EngineWindowMaps): number | null {
  for (const e of windowEngines(model, lists)) {
    const n = windows[e]?.[model]
    if (n) return n
  }
  return null
}

/**
 * 要补的：能跑这个模型的引擎有的填了、有的没填（老版本只写 Claude Code / Codex，像素星空就按系列自动定，
 * 和输入框里显示的不一样）——把显示的值补给没填的。填了不同值的不动（改一次输入框就统一了）
 */
export function windowBackfill(
  models: readonly string[],
  lists: EngineModelLists,
  windows: EngineWindowMaps,
): Array<{ engine: EngineId; model: string; value: number }> {
  const out: Array<{ engine: EngineId; model: string; value: number }> = []
  for (const model of models) {
    const value = sharedWindow(model, lists, windows)
    if (value === null) continue
    for (const engine of windowEngines(model, lists)) if (!windows[engine]?.[model]) out.push({ engine, model, value })
  }
  return out
}

/** 一次补写的标识：同一个值只补一次 */
export const backfillId = (w: { engine: EngineId; model: string; value: number }): string =>
  `${w.engine}|${w.model}|${w.value}`

/**
 * 清空一个模型的窗口时不再补的：清空逐个引擎写、写一个广播一次，中间「有的空了、有的还没」看起来和老版本漏填一样，
 * 不跳过就会把旧值补回来
 */
export function clearedBackfills(model: string, lists: EngineModelLists, windows: EngineWindowMaps): string[] {
  const engines = windowEngines(model, lists)
  const values = engines.flatMap(e => windows[e]?.[model] ?? [])
  return engines.flatMap(engine => values.map(value => backfillId({ engine, model, value })))
}

/** 菜单里这个模型一共有几条线路：各引擎目录里含它的分组（同一个分组只算一次） */
export function routeCount(
  model: string,
  groups: Partial<Record<EngineId, ReadonlyArray<{ id: string; models: readonly string[] }>>>,
): number {
  return new Set(ORDER.flatMap(e => (groups[e] ?? []).filter(g => g.models.includes(model)).map(g => g.id))).size
}
