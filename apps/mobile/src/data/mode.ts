// 输入框上方的「模式胶囊」文字（C1 只读，docs/mobile-remote.md §21.12.3）：「每步问我 · Sonnet 4.5 · 中」
import {
  ENGINES,
  type Effort,
  type EngineId,
  type EngineModel,
  type PermissionMode,
  type SessionSettings,
} from '@pixelsky/protocol'

const PERMISSION: Record<PermissionMode, string> = {
  ask: '每步问我',
  edits: '自动改文件',
  plan: '只规划',
  full: '完全放行',
}

const EFFORT: Record<Effort, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  ultra: '极致',
}

const MAX_RAW = 16

/**
 * 模型名简化：claude-sonnet-4-5-2025… → 「Sonnet 4.5」，claude-3-5-sonnet-… → 「Sonnet 3.5」，别名 sonnet → 「Sonnet」；
 * 认不出的显示原文，太长截断。手机拿不到模型目录，自定义模型名只能这样猜（C2 开放 catalog 后换正式名）。
 */
export function modelLabel(model: string): string {
  const name = model.trim().replace(/\[\w+\]$/, '')
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase()
  const next = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(name)
  if (next) return `${cap(next[1])} ${next[2]}${next[3] ? `.${next[3]}` : ''}`
  const old = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?!\w)/i.exec(name)
  if (old) return `${cap(old[3])} ${old[1]}${old[2] ? `.${old[2]}` : ''}`
  if (/^(opus|sonnet|haiku)$/i.test(name)) return cap(name)
  return name.length > MAX_RAW ? `${name.slice(0, MAX_RAW)}…` : name
}

export interface ModeChip {
  permission: string
  /** 没指定模型（用引擎默认）时为 null，不显示 */
  model: string | null
  /** 没指定强度时为 null，不显示 */
  effort: string | null
}

export function modeChip(record: Pick<SessionSettings, 'permissionMode' | 'model' | 'effort'>): ModeChip {
  return {
    permission: PERMISSION[record.permissionMode] ?? record.permissionMode,
    model: record.model ? modelLabel(record.model) : null,
    effort: record.effort ? (EFFORT[record.effort] ?? record.effort) : null,
  }
}

// ---------------------------------------------------------------------------
// 改模式（C2，docs/mobile-remote.md §21.5）：面板里能选什么。界面在 ui/ModeSheet，这里只算选项。
// 值 '' 表示「用电脑上的默认」（模型、强度为 null；新建会话时权限模式也可以不指定）。
// ---------------------------------------------------------------------------

export interface ModeOption {
  value: string
  label: string
  hint?: string
  disabled?: boolean
}

/** 手机能切的三档（从严到宽）；完全放行只能在电脑上开 */
const PHONE_MODES: PermissionMode[] = ['plan', 'ask', 'edits']
const RANK: Record<PermissionMode, number> = { plan: 0, ask: 1, edits: 2, full: 3 }
const PERMISSION_HINT: Partial<Record<PermissionMode, string>> = {
  plan: '只读代码、写计划，不改文件',
  ask: '改文件、运行命令前都问你',
  edits: '改文件不问，运行命令前问你',
}

/** 往更宽的权限切（要确认一次） */
export const widens = (from: PermissionMode | null, to: PermissionMode): boolean => RANK[to] > RANK[from ?? 'ask']

export function permissionOptions(engine: EngineId, current: PermissionMode | null): ModeOption[] {
  const caps = ENGINES[engine]?.caps.permissionModes ?? PHONE_MODES
  const out: ModeOption[] = PHONE_MODES.filter(m => caps.includes(m)).map(m => ({
    value: m,
    label: PERMISSION[m],
    hint: PERMISSION_HINT[m],
  }))
  // 电脑上已经是完全放行：显示出来但选不了，只能往下降
  if (current === 'full') out.push({ value: 'full', label: PERMISSION.full, hint: '只能在电脑上打开', disabled: true })
  // 新建会话：可以不指定，用电脑上的设置
  if (current === null) out.unshift({ value: '', label: '电脑上的设置' })
  return out
}

export function modelOptions(models: readonly EngineModel[] | null, current: string | null): ModeOption[] {
  const out: ModeOption[] = [{ value: '', label: '默认', hint: '用电脑上设的模型' }]
  for (const m of models ?? []) out.push({ value: m.id, label: m.label || modelLabel(m.id), hint: m.description })
  // 目录里没有当前这个（自定义模型、目录还没取到）：照样列出来，标成当前
  if (current && !out.some(o => o.value === current)) out.push({ value: current, label: modelLabel(current) })
  return out
}

export function effortOptions(engine: EngineId, model: EngineModel | undefined, current: Effort | null): ModeOption[] {
  const efforts = model?.efforts.length ? model.efforts : (ENGINES[engine]?.caps.efforts ?? [])
  const out: ModeOption[] = [{ value: '', label: '默认' }, ...efforts.map(e => ({ value: e, label: EFFORT[e] ?? e }))]
  if (current && !efforts.includes(current)) out.push({ value: current, label: EFFORT[current] ?? current })
  return out
}
