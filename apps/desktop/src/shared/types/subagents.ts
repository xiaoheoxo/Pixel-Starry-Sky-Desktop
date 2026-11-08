// 设置 › 子智能体（docs/ui/subagent-routing.md）：像素星空引擎的子智能体分类型，每个类型可以单独选站点和模型、工具权限。
// 主进程存、渲染进程改；Claude Code / Codex 会话不受影响。

import { subagentEffort, type Effort } from '@pixelsky/protocol'

/** 子智能体单独走的站点：自定义接口，或像素星空平台的一条线路（account 是选的时候登录的账号） */
export type SubagentTarget =
  | { kind: 'custom'; providerId: string; model: string }
  | { kind: 'platform'; groupId: string; account: string; model: string }

/** 分组：平台的一条线路，或一个自定义接口 */
export type SubagentSite = { kind: 'custom'; providerId: string } | { kind: 'platform'; groupId: string }

/** 主模型调度（docs/ui/subagent-model-dispatch.md）：规则里一个可选的模型 */
export interface SubagentDispatchCandidate {
  target: SubagentTarget
  /** 给主模型看的「什么时候选它」 */
  note: string
  /** 主模型不填 model 时用它 */
  isDefault?: boolean
}
/** 主模型是某个分组的某个模型时，这个类型能选哪些模型（模型名不重复：主模型只按模型名选） */
export interface SubagentDispatchRule {
  main: { site: SubagentSite; model: string }
  candidates: SubagentDispatchCandidate[]
}
export interface SubagentDispatch {
  rules: SubagentDispatchRule[]
  /** 允许调度分组以外的模型（还要逐个加进规则才生效） */
  outsideGroup: boolean
  /** 没写规则的主模型：cheaper 同分组不比它贵的；self 用它自己 */
  unruled: 'cheaper' | 'self'
}

export const SUBAGENT_MAX_MINUTES = [10, 30, 60] as const
export type SubagentMaxMinutes = (typeof SUBAGENT_MAX_MINUTES)[number]
export const SUBAGENT_CONCURRENCY = [1, 2, 4, 8] as const
export type SubagentConcurrency = (typeof SUBAGENT_CONCURRENCY)[number]
/** all：和主会话一样的工具；read：只读（读、搜、查网页，不改文件、不跑命令、不用 MCP） */
export type SubagentTools = 'all' | 'read'

export interface SubagentType {
  /** 未设置或 null：启动子任务时跟随主会话的强度。 */
  effort?: Effort | null
  /** 标识：主会话调用 task 时用；小写字母开头，字母数字和 - */
  id: string
  name: string
  /** 什么时候用：写进 task 工具的说明，主会话按它挑类型 */
  description: string
  /** null：跟随主会话 */
  target: SubagentTarget | null
  /** 主模型调度：有它时 target 不起作用（和 target 互斥）；老版本的设置没有 */
  dispatch?: SubagentDispatch | null
  tools: SubagentTools
  maxMinutes: SubagentMaxMinutes
  /** 追加在它的系统提示后面 */
  instructions: string
  enabled: boolean
}

export interface SubagentSettings {
  types: SubagentType[]
  /** 站点出错、子智能体还没开始干活时改走主会话的站点重来一次 */
  fallback: boolean
  /** 一个会话同时运行的子智能体上限 */
  maxConcurrent: SubagentConcurrency
}

export const GENERAL_TYPE = 'general'
export const EXPLORE_TYPE = 'explore'
export const SUBAGENT_TYPE_ID = /^[a-z][a-z0-9-]{0,31}$/
export const MAX_SUBAGENT_TYPES = 20
export const SUBAGENT_LIMITS = {
  name: 30,
  description: 500,
  instructions: 2000,
  dispatchRules: 20,
  dispatchCandidates: 10,
  dispatchNote: 200,
} as const

/** 内置类型的默认值（「恢复默认」回到这里）；通用不能关、不能删 */
export const BUILTIN_SUBAGENT_TYPES: readonly SubagentType[] = [
  {
    id: GENERAL_TYPE,
    name: '通用',
    description: '什么都能做的子智能体，工具和主会话一样。没有更合适的类型时用它。',
    target: null,
    tools: 'all',
    maxMinutes: 30,
    instructions: '',
    enabled: true,
  },
  {
    id: EXPLORE_TYPE,
    name: '探索',
    description: '只读地查代码、找文件、读文档，回答「在哪里」「怎么实现的」。不改任何文件、不跑命令。',
    target: null,
    tools: 'read',
    maxMinutes: 10,
    instructions: '回答要简短，列出相关文件路径和行号。',
    enabled: true,
  },
]
export const isBuiltinSubagentType = (id: string): boolean => BUILTIN_SUBAGENT_TYPES.some(t => t.id === id)

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
  types: BUILTIN_SUBAGENT_TYPES.map(t => ({ ...t })),
  fallback: true,
  maxConcurrent: 4,
}

const id = (v: unknown, pattern: RegExp): string | null => (typeof v === 'string' && pattern.test(v) ? v : null)
/** 模型名：不含控制字符和空白，最长 200 */
// eslint-disable-next-line no-control-regex
const MODEL = /^[^\s\u0000-\u001f\u007f]{1,200}$/
const PROVIDER = /^[A-Za-z0-9_-]{1,64}$/
const GROUP = /^\d{1,20}$/
/** 去掉换行、制表符以外的控制字符，截到上限 */
const clean = (v: unknown, max: number): string =>
  // eslint-disable-next-line no-control-regex
  typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max) : ''
const pick = <T>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)

/**
 * 读盘、收 IPC 时都过一遍：认不出的字段回到默认，不抛错。内置类型总在（缺了补上、通用总是开着），
 * 标识重复的只留第一个；第一期的格式（一个 target）当成通用类型的站点。
 */
export function parseSubagentSettings(raw: unknown): SubagentSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const list: unknown[] = Array.isArray(o.types)
    ? o.types
    : 'target' in o || 'maxMinutes' in o
      ? [{ ...BUILTIN_SUBAGENT_TYPES[0], target: o.target, maxMinutes: o.maxMinutes ?? 30 }]
      : []
  const types: SubagentType[] = []
  for (const item of list) {
    const t = parseType(item)
    if (t && !types.some(x => x.id === t.id) && types.length < MAX_SUBAGENT_TYPES) types.push(t)
  }
  // 缺了的内置类型补在前一个内置类型后面（第一个补在最前）
  for (const [i, builtin] of BUILTIN_SUBAGENT_TYPES.entries()) {
    if (types.some(t => t.id === builtin.id)) continue
    const prev = i > 0 ? types.findIndex(t => t.id === BUILTIN_SUBAGENT_TYPES[i - 1]!.id) : -1
    types.splice(prev + 1, 0, { ...builtin })
  }
  const general = types.find(t => t.id === GENERAL_TYPE)!
  general.enabled = true
  return {
    types,
    fallback: typeof o.fallback === 'boolean' ? o.fallback : DEFAULT_SUBAGENT_SETTINGS.fallback,
    maxConcurrent: pick(SUBAGENT_CONCURRENCY, o.maxConcurrent, DEFAULT_SUBAGENT_SETTINGS.maxConcurrent),
  }
}

function parseType(raw: unknown): SubagentType | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const typeId = id(t.id, SUBAGENT_TYPE_ID)
  if (!typeId) return null
  const builtin = BUILTIN_SUBAGENT_TYPES.find(b => b.id === typeId)
  const name = clean(t.name, SUBAGENT_LIMITS.name).trim()
  const description = clean(t.description, SUBAGENT_LIMITS.description).trim()
  const dispatch = parseDispatch(t.dispatch)
  return {
    id: typeId,
    // 内置类型的名字不能改
    name: builtin?.name ?? (name || typeId),
    description: description || builtin?.description || '',
    target: dispatch ? null : parseTarget(t.target),
    ...(subagentEffort(t.effort) ? { effort: subagentEffort(t.effort) } : {}),
    ...(dispatch ? { dispatch } : {}),
    tools: pick<SubagentTools>(['all', 'read'], t.tools, builtin?.tools ?? 'all'),
    maxMinutes: pick(SUBAGENT_MAX_MINUTES, t.maxMinutes, builtin?.maxMinutes ?? 30),
    instructions:
      typeof t.instructions === 'string'
        ? clean(t.instructions, SUBAGENT_LIMITS.instructions).trim()
        : (builtin?.instructions ?? ''),
    enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
  }
}

function parseTarget(raw: unknown): SubagentTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const model = id(t.model, MODEL)
  if (!model) return null
  if (t.kind === 'custom') {
    const providerId = id(t.providerId, PROVIDER)
    return providerId ? { kind: 'custom', providerId, model } : null
  }
  if (t.kind === 'platform') {
    const groupId = id(t.groupId, GROUP)
    const account = typeof t.account === 'string' && t.account && t.account.length <= 320 ? t.account : null
    return groupId && account ? { kind: 'platform', groupId, account, model } : null
  }
  return null
}

function parseSite(raw: unknown): SubagentSite | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (s.kind === 'custom') {
    const providerId = id(s.providerId, PROVIDER)
    return providerId ? { kind: 'custom', providerId } : null
  }
  if (s.kind === 'platform') {
    const groupId = id(s.groupId, GROUP)
    return groupId ? { kind: 'platform', groupId } : null
  }
  return null
}

function parseCandidates(raw: unknown): SubagentDispatchCandidate[] {
  const out: SubagentDispatchCandidate[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= SUBAGENT_LIMITS.dispatchCandidates) break
    const c = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const target = parseTarget(c.target)
    if (!target || out.some(x => x.target.model === target.model)) continue
    // 说明会进提示词：压成一行
    const note = clean(c.note, SUBAGENT_LIMITS.dispatchNote).replace(/\s+/g, ' ').trim()
    const isDefault = c.isDefault === true && !out.some(x => x.isDefault)
    out.push({ target, note, ...(isDefault ? { isDefault } : {}) })
  }
  return out
}

function parseDispatch(raw: unknown): SubagentDispatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const d = raw as Record<string, unknown>
  const rules: SubagentDispatchRule[] = []
  for (const item of Array.isArray(d.rules) ? d.rules : []) {
    if (rules.length >= SUBAGENT_LIMITS.dispatchRules) break
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const m = (r.main && typeof r.main === 'object' ? r.main : {}) as Record<string, unknown>
    const site = parseSite(m.site)
    const model = id(m.model, MODEL)
    if (!site || !model) continue
    const main = { site, model }
    if (rules.some(x => x.main.model === model && JSON.stringify(x.main.site) === JSON.stringify(site))) continue
    rules.push({ main, candidates: parseCandidates(r.candidates) })
  }
  return {
    rules,
    outsideGroup: d.outsideGroup === true,
    unruled: d.unruled === 'self' ? 'self' : 'cheaper',
  }
}

/** preload 的 window.pixelsky.subagents */
export interface SubagentsBridge {
  get(): Promise<SubagentSettings>
  set(settings: SubagentSettings): Promise<SubagentSettings>
  onChange(callback: (settings: SubagentSettings) => void): () => void
}
