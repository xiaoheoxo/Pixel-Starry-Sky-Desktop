// 多个审批同时出现时合并成一张列表卡（docs/ui/approval-stack.md）：哪些单独成卡、怎么分组、每项一行摘要、批量逐项发送
import type { AlwaysScope, ApprovalDecision, ApprovalRequest } from '@pixelsky/protocol'
import { tr } from '../../../../i18n/core'

/** 要填写或细看的：提问、计划、要填表单的 MCP 请求。不进列表，单独一张完整卡 */
export const isSolo = (r: ApprovalRequest): boolean =>
  r.kind === 'question' || r.kind === 'plan' || r.formSchema !== undefined

export type ApprovalEntry =
  | { kind: 'row'; request: ApprovalRequest }
  | { kind: 'group'; key: string; label: string; short: string; requests: ApprovalRequest[] }

/**
 * 列表里的排法：顺序和 AI 发出的一致；同一个工具 2 项以上排成一组，组的位置按组里第一项
 */
export function layoutApprovals(list: readonly ApprovalRequest[]): ApprovalEntry[] {
  const groupKey = (r: ApprovalRequest): string | null =>
    r.kind === 'tool' && r.toolName ? `tool:${r.toolName}` : null
  const counts = new Map<string, number>()
  for (const r of list) {
    const key = groupKey(r)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const out: ApprovalEntry[] = []
  const groups = new Map<string, Extract<ApprovalEntry, { kind: 'group' }>>()
  for (const r of list) {
    const key = groupKey(r)
    if (!key || (counts.get(key) ?? 0) < 2) {
      out.push({ kind: 'row', request: r })
      continue
    }
    const group = groups.get(key)
    if (group) group.requests.push(r)
    else {
      const label = toolLabel(r.toolName, r.description)
      const next = { kind: 'group' as const, key, label, short: label.split(' · ').at(-1) ?? label, requests: [r] }
      groups.set(key, next)
      out.push(next)
    }
  }
  return out
}

/** 组上「始终允许」能选的范围：组里每一项都能选的 */
export function commonScopes(requests: readonly ApprovalRequest[]): AlwaysScope[] {
  if (requests.length === 0) return []
  return requests[0].alwaysScopes.filter(s => requests.every(r => r.alwaysScopes.includes(s)))
}

/** 工具名给人看：mcp__github__create_pull_request → github · create_pull_request；没有工具名用说明 */
export function toolLabel(toolName: string | undefined, description?: string): string {
  if (toolName?.startsWith('mcp__')) {
    const rest = toolName.slice(5)
    const at = rest.indexOf('__')
    return at > 0 ? `${rest.slice(0, at)} · ${rest.slice(at + 2)}` : rest
  }
  return toolName || description || ''
}

export interface ApprovalSummary {
  /** 前面灰色的「谁」：github · create_pull_request、WebFetch；分组里的行不写 */
  label: string | null
  /** 主体：命令、pattern、地址、路径…；改文件时是「修改 3 个文件」 */
  text: string
  /** 主体用等宽字 */
  mono: boolean
  /** 后面灰色的补充：路径最后两段、项目名、文件名 */
  hint: string | null
  /** 补充只留文件名（窄窗格用） */
  hintShort: string | null
  /** 悬停看的完整一行 */
  full: string
  /** 展开后先写的一行：完整路径、命令所在目录 */
  where: string | null
  /** 路径在项目外 */
  outside: boolean
  /** Codex 命令的外层 shell 还带了额外参数 */
  wrapped?: boolean
  added?: number
  removed?: number
}

const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'dir', 'directory'] as const
const SEARCH_KEYS = ['pattern', 'query', 'q', 'search', 'regex'] as const
const URL_KEYS = ['url', 'uri'] as const
const COMMAND_KEYS = ['command', 'cmd'] as const
const TITLE_KEYS = ['title', 'subject', 'name', 'message'] as const
const VALUE_MAX = 30

const slashes = (p: string): string => p.replace(/\\/g, '/')
const segments = (p: string): string[] => slashes(p).split('/').filter(Boolean)
/** 路径最后两段：client/format.ts */
export const lastTwo = (p: string): string => segments(p).slice(-2).join('/')
const baseName = (p: string): string => segments(p).at(-1) ?? p

/** 路径在不在工作目录里面（Windows 不分大小写） */
export function outsideOf(path: string, cwd: string | null): boolean {
  if (!cwd) return false
  const p = slashes(path)
  if (!/^([a-z]:\/|\/)/i.test(p)) return false
  const root = slashes(cwd).replace(/\/+$/, '')
  const windows = /^[a-z]:\//i.test(root)
  const [a, b] = windows ? [p.toLowerCase(), root.toLowerCase()] : [p, root]
  return !(a === b || a.startsWith(`${b}/`))
}

const firstString = (input: Record<string, unknown>, keys: readonly string[]): [string, string] | null => {
  for (const key of keys) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) return [key, v]
  }
  return null
}

const shortValue = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > VALUE_MAX ? `${s.slice(0, VALUE_MAX - 1)}…` : s
}

/** 每项一行的摘要：挑最有用的参数（docs/ui/approval-stack.md §3） */
export function approvalSummary(r: ApprovalRequest, cwd: string | null): ApprovalSummary {
  const project = cwd ? baseName(cwd) : null
  if (r.kind === 'command') {
    const lines = (r.command ?? '').split('\n')
    const text = lines.length > 1 ? `${lines[0]} …` : lines[0]
    return {
      label: null,
      text,
      mono: true,
      hint: project,
      hintShort: null,
      full: [r.command ?? '', r.wrapper?.line, r.description].filter(Boolean).join('\n'),
      where: cwd,
      outside: false,
      wrapped: !!r.wrapper?.extra.length,
    }
  }
  if (r.kind === 'file_change') {
    const changes = r.changes ?? []
    const names = changes.slice(0, 2).map(c => baseName(c.path))
    const hint = names.length
      ? `${names.join(tr('approvals.listSep'))}${changes.length > 2 ? tr('approvals.andMore') : ''}`
      : null
    return {
      label: null,
      text: tr('approvals.files', { n: changes.length }),
      mono: false,
      hint,
      hintShort: hint,
      full: changes.map(c => c.path).join('\n'),
      where: changes.length === 1 ? changes[0].path : null,
      outside: changes.some(c => outsideOf(c.path, cwd)),
      added: changes.reduce((n, c) => n + c.added, 0),
      removed: changes.reduce((n, c) => n + c.removed, 0),
    }
  }
  const label = toolLabel(r.toolName, r.description) || r.title
  const input =
    r.input && typeof r.input === 'object' && !Array.isArray(r.input) ? (r.input as Record<string, unknown>) : {}
  const path = firstString(input, PATH_KEYS)
  const where = path ? path[1] : null
  const outside = path ? outsideOf(path[1], cwd) : false
  const command = firstString(input, COMMAND_KEYS)
  if (command) {
    const line = command[1].split('\n')[0]
    return { label, text: line, mono: true, hint: null, hintShort: null, full: command[1], where: cwd, outside: false }
  }
  const search = firstString(input, SEARCH_KEYS)
  if (search) {
    return {
      label,
      text: search[1],
      mono: true,
      hint: path ? lastTwo(path[1]) : null,
      hintShort: path ? baseName(path[1]) : null,
      full: path ? `${search[1]}\n${path[1]}` : search[1],
      where,
      outside,
    }
  }
  const url = firstString(input, URL_KEYS)
  if (url) {
    const text = url[1].replace(/^https?:\/\//, '')
    return { label, text, mono: true, hint: null, hintShort: null, full: url[1], where: null, outside: false }
  }
  const titled = firstString(input, TITLE_KEYS)
  if (titled) {
    // 开 PR 这类：标题 + 分支 → 目标分支
    const branch =
      typeof input.head === 'string' && typeof input.base === 'string' ? `${input.head} → ${input.base}` : null
    return {
      label,
      text: titled[1].split('\n')[0],
      mono: false,
      hint: branch,
      hintShort: branch,
      full: JSON.stringify(input, null, 2),
      where,
      outside,
    }
  }
  if (path) {
    const parts = segments(path[1])
    const text = parts.length > 2 ? `…/${lastTwo(path[1])}` : slashes(path[1])
    return { label, text, mono: true, hint: null, hintShort: null, full: path[1], where, outside }
  }
  const pairs = Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .slice(0, 2)
    .map(([k, v]) => `${k}=${shortValue(v)}`)
  return {
    label,
    text: pairs.join(', '),
    mono: pairs.length > 0,
    hint: null,
    hintShort: null,
    full: pairs.length ? JSON.stringify(input, null, 2) : label,
    where: null,
    outside: false,
  }
}

/** 批量时每一项发什么；null 是跳过（只能拒绝的跳过「全部允许」，不能拒绝的跳过「全部拒绝」） */
export const allowOnce = (r: ApprovalRequest): ApprovalDecision | null =>
  r.canAllow === false ? null : { type: 'allow' }
export const denyOnce = (r: ApprovalRequest): ApprovalDecision | null => (r.canDeny === false ? null : { type: 'deny' })

/** 组上「始终允许」：第一项带上范围，其余的允许一次（规则已经加上了，不用每项再写一遍） */
export function alwaysForGroup(scope: AlwaysScope): (r: ApprovalRequest, index: number) => ApprovalDecision | null {
  return (r, index) => (r.canAllow === false ? null : index === 0 ? { type: 'allow_always', scope } : { type: 'allow' })
}

/** 「本会话后续不再询问」：第一项能切完全放行的发 allow_all，其余允许一次 */
export function allowAllDecisions(requests: readonly ApprovalRequest[]): Map<string, ApprovalDecision> {
  const out = new Map<string, ApprovalDecision>()
  const first = requests.find(r => r.canAllowAll)
  for (const r of requests) {
    if (r === first) out.set(r.requestId, { type: 'allow_all' })
    else if (r.canAllow !== false) out.set(r.requestId, { type: 'allow' })
  }
  return out
}

export type StepState = 'sending' | 'sent' | 'failed'

export interface BatchResult {
  sent: string[]
  failed: Array<{ requestId: string; message: string; decision: ApprovalDecision }>
  skipped: string[]
}

/**
 * 按顺序逐项发；一项失败不影响后面的。只处理调用时传进来的这些（点下去那一刻已有的项）
 */
export async function answerInOrder(
  requests: readonly ApprovalRequest[],
  decide: (r: ApprovalRequest, index: number) => ApprovalDecision | null,
  send: (r: ApprovalRequest, d: ApprovalDecision) => Promise<unknown> | unknown,
  onStep?: (requestId: string, state: StepState, message?: string) => void,
): Promise<BatchResult> {
  const result: BatchResult = { sent: [], failed: [], skipped: [] }
  let index = 0
  for (const r of requests) {
    const decision = decide(r, index)
    if (!decision) {
      result.skipped.push(r.requestId)
      continue
    }
    index++
    onStep?.(r.requestId, 'sending')
    try {
      await send(r, decision)
      result.sent.push(r.requestId)
      onStep?.(r.requestId, 'sent')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      result.failed.push({ requestId: r.requestId, message, decision })
      onStep?.(r.requestId, 'failed', message)
    }
  }
  return result
}

/** 决定的结果给已处理的行写字：允许 / 拒绝 */
export const decisionResult = (d: ApprovalDecision): 'allow' | 'deny' => (d.type === 'deny' ? 'deny' : 'allow')

/** 只留还在等的请求：发送失败后又在别处处理掉的（超时、手机上点的）不再算失败。没有要删的返回原来那个，不触发重渲染 */
export function keepPending<V>(map: ReadonlyMap<string, V>, pending: (id: string) => boolean): ReadonlyMap<string, V> {
  if ([...map.keys()].every(pending)) return map
  return new Map([...map].filter(([id]) => pending(id)))
}
