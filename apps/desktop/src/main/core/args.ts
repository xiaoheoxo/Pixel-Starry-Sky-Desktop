// 渲染进程 / 远端调用传来的参数校验：本机 IPC 和远端辅助进程共用同一份（docs/restructure.md §8.3 P6）
import { isAbsolute } from 'node:path'
import type { UsageQuery } from '@pixelsky/engine'
import { COST_MISSING, COST_STATES } from '@pixelsky/protocol'
import type { EngineConfigPatch, EngineId, McpOp, UsageDimension, UsageFilter, UsageRangeId } from '@pixelsky/protocol'

export { value } from './project-tools/common'

/** 非空字符串（会话、队列项等 ID） */
export function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`参数 ${name} 不对`)
  return v
}

/** 非负整数，超出范围截断，不是数字时取默认值 */
export function int(v: unknown, fallback: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : fallback
}

export function engineId(v: unknown): EngineId {
  if (v !== 'claude' && v !== 'codex' && v !== 'pixel') throw new Error('未知引擎')
  return v
}

/**
 * 连接器操作（docs/ui/connectors.md）：服务器名要原样交给引擎（像素星空拼进 /pixelsky-mcp 命令），
 * 不能有空白和换行
 */
export function mcpOp(v: unknown): McpOp {
  const op = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  if (op.kind === 'refresh') return { kind: 'refresh' }
  const name = op.name
  if (typeof name !== 'string' || !/^\S{1,200}$/.test(name)) throw new Error('连接器名字不对')
  if (op.kind === 'reconnect' || op.kind === 'login') return { kind: op.kind, name }
  if (op.kind === 'toggle' && typeof op.enabled === 'boolean') return { kind: 'toggle', name, enabled: op.enabled }
  throw new Error('未知的连接器操作')
}

const RANGES: readonly UsageRangeId[] = ['today', '7d', '30d', '90d']
const DIMENSIONS: readonly UsageDimension[] = ['model', 'project', 'engine', 'route', 'cost']
/** 费用情况只认这几个值（docs/ui/usage.md §12） */
const COST_VALUES: readonly string[] = [COST_MISSING, ...COST_STATES]

/** 用量查询参数（docs/ui/usage.md §6.3）：只取认识的字段 */
export function usageQuery(v: unknown): UsageQuery {
  const q = (v ?? {}) as { range?: unknown; filter?: unknown; now?: unknown }
  const range = RANGES.includes(q.range as UsageRangeId) ? (q.range as UsageRangeId) : 'today'
  const filter: UsageFilter = {}
  const raw = (q.filter ?? {}) as Record<string, unknown>
  for (const d of DIMENSIONS) if (typeof raw[d] === 'string') filter[d] = raw[d] as string
  if (filter.cost !== undefined && !COST_VALUES.includes(filter.cost)) delete filter.cost
  const now = typeof q.now === 'number' && Number.isFinite(q.now) ? q.now : Date.now()
  return { range, filter, now }
}

/** 调用记录分页：用量查询 + offset / limit */
export function usageListQuery(v: unknown): UsageQuery & { offset: number; limit: number } {
  const o = (v ?? {}) as { offset?: unknown; limit?: unknown }
  return { ...usageQuery(v), offset: int(o.offset, 0, Number.MAX_SAFE_INTEGER), limit: int(o.limit, 50, 500) }
}

/** 产物接口的参数：会话 id + 绝对路径 / 条目 id */
export function artifactRef(input: unknown): { sessionId: string; path: string; itemId?: unknown } {
  const v = (input ?? {}) as { sessionId?: unknown; path?: unknown; itemId?: unknown }
  const sessionId = str(v.sessionId, 'sessionId')
  const path = typeof v.path === 'string' ? v.path : ''
  if (path && (!isAbsolute(path) || path.includes('\0') || path.length > 4096)) throw new Error('文件路径不正确')
  return { sessionId, path, itemId: v.itemId }
}

/** 引擎设置的修改：类型在这里先过一遍，取值范围由 EngineHost 校验（docs/ui/engine-settings-redesign.md） */
export function engineConfigPatch(patch: unknown): EngineConfigPatch {
  const p = (patch ?? {}) as Record<string, unknown>
  const out: EngineConfigPatch = {}
  if (p.path === null || typeof p.path === 'string') out.path = p.path
  if (Array.isArray(p.args) && p.args.every(a => typeof a === 'string')) out.args = p.args as string[]
  if (p.compactModel === null || typeof p.compactModel === 'string') out.compactModel = p.compactModel
  if (p.env && typeof p.env === 'object')
    out.env = Object.fromEntries(
      Object.entries(p.env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
    )
  if (p.defaults && typeof p.defaults === 'object') out.defaults = p.defaults as EngineConfigPatch['defaults']
  if (p.outputStyle === null || typeof p.outputStyle === 'string') out.outputStyle = p.outputStyle
  if (typeof p.askQuestions === 'boolean') out.askQuestions = p.askQuestions
  if (p.autoCompactPct === null || typeof p.autoCompactPct === 'number') out.autoCompactPct = p.autoCompactPct
  if (typeof p.hidden === 'boolean') out.hidden = p.hidden
  if (typeof p.rememberChoices === 'boolean') out.rememberChoices = p.rememberChoices
  // 每个模型的上下文窗口（GitHub #20）：只留 { platform | self: { 模型: 数字 | null } } 的形状，范围由 EngineHost 查
  if (p.contextWindows && typeof p.contextWindows === 'object' && !Array.isArray(p.contextWindows)) {
    const windows: NonNullable<EngineConfigPatch['contextWindows']> = {}
    for (const source of ['platform', 'self'] as const) {
      const list = (p.contextWindows as Record<string, unknown>)[source]
      if (!list || typeof list !== 'object' || Array.isArray(list)) continue
      windows[source] = Object.fromEntries(
        Object.entries(list).filter((e): e is [string, number | null] => e[1] === null || typeof e[1] === 'number'),
      )
    }
    out.contextWindows = windows
  }
  return out
}
