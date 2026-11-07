// 输入框上方的「模式胶囊」文字（C1 只读，docs/mobile-remote.md §21.12.3）：「每步问我 · Sonnet 4.5 · 中」
import {
  ENGINES,
  type Effort,
  type EngineId,
  type EngineModel,
  type PermissionMode,
  type SessionFlags,
  type SessionSettings,
} from '@pixelsky/protocol'
import { L } from '@/i18n'

const PERMISSION = (): Record<PermissionMode, string> => ({
  ask: L('每步问我', 'Ask every step'),
  edits: L('自动改文件', 'Auto-edit files'),
  auto: L('自动审核', 'Auto-review'),
  plan: L('只规划', 'Plan only'),
  full: L('完全放行', 'Full access'),
})

const EFFORT = (): Record<Effort, string> => ({
  low: L('低', 'Low'),
  medium: L('中', 'Medium'),
  high: L('高', 'High'),
  xhigh: L('超高', 'Extra high'),
  max: L('最高', 'Max'),
  ultra: L('极致', 'Ultra'),
})

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
    permission: PERMISSION()[record.permissionMode] ?? record.permissionMode,
    model: record.model ? modelLabel(record.model) : null,
    effort: record.effort ? (EFFORT()[record.effort] ?? record.effort) : null,
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
const RANK: Record<PermissionMode, number> = { plan: 0, ask: 1, edits: 2, auto: 3, full: 4 }
const PERMISSION_HINT = (): Partial<Record<PermissionMode, string>> => ({
  plan: L('只读代码、写计划，不改文件', 'Reads code and writes a plan, no file changes'),
  ask: L('改文件、运行命令前都问你', 'Asks you before editing files or running commands'),
  edits: L('改文件不问，运行命令前问你', 'Edits files freely, asks before running commands'),
})

/** 往更宽的权限切（要确认一次） */
export const widens = (from: PermissionMode | null, to: PermissionMode): boolean => RANK[to] > RANK[from ?? 'ask']

export function permissionOptions(engine: EngineId, current: PermissionMode | null): ModeOption[] {
  const caps = ENGINES[engine]?.caps.permissionModes ?? PHONE_MODES
  const labels = PERMISSION()
  const hints = PERMISSION_HINT()
  const out: ModeOption[] = PHONE_MODES.filter(m => caps.includes(m)).map(m => ({
    value: m,
    label: labels[m],
    hint: hints[m],
  }))
  // 电脑上已经是完全放行：显示出来但选不了，只能往下降
  if (current === 'full')
    out.push({
      value: 'full',
      label: labels.full,
      hint: L('只能在电脑上打开', 'Can only be turned on on the computer'),
      disabled: true,
    })
  // 新建会话：可以不指定，用电脑上的设置
  if (current === null) out.unshift({ value: '', label: L('电脑上的设置', "Computer's settings") })
  return out
}

export function modelOptions(models: readonly EngineModel[] | null, current: string | null): ModeOption[] {
  const out: ModeOption[] = [
    { value: '', label: L('默认', 'Default'), hint: L('用电脑上设的模型', 'Uses the model set on the computer') },
  ]
  for (const m of models ?? []) out.push({ value: m.id, label: m.label || modelLabel(m.id), hint: m.description })
  // 目录里没有当前这个（自定义模型、目录还没取到）：照样列出来，标成当前
  if (current && !out.some(o => o.value === current)) out.push({ value: current, label: modelLabel(current) })
  return out
}

// ---------------------------------------------------------------------------
// 快速模式（docs/mobile-remote.md §25）：引擎有 fast 能力才显示开关；开不了时开关变灰并写原因（和桌面 engine/labels 的说法一样）
// ---------------------------------------------------------------------------

const FAST_BLOCKED = (): Record<string, string> => ({
  free: L('免费账号不能用', 'Not available on free accounts'),
  preference: L('账号没有开启 Fast 模式', 'Fast mode is not enabled for this account'),
  extra_usage_disabled: L('账号没有开启额外用量', 'Extra usage is not enabled for this account'),
  network_error: L('网络错误', 'Network error'),
  not_first_party: L('只支持 Anthropic 官方接口', 'Only supported with the official Anthropic API'),
  disabled_by_env: L('被环境变量关闭了', 'Disabled by an environment variable'),
  model_not_allowed: L('当前模型不支持', 'Not supported by the current model'),
  pending: L('正在确认账号状态', 'Checking account status'),
})

const FAST_HINT = (): Record<string, string> => ({
  codex_gateway: L(
    '接口支持 Fast 时生效，不支持的打开了也没有效果',
    'Takes effect if the API supports Fast; otherwise turning it on does nothing',
  ),
  codex_unverified: L(
    '你的接口或当前模型可能不支持 Fast，打开了可能不生效',
    'Your API or the current model may not support Fast, so it might not take effect',
  ),
})

export const fastDefaultHint = () => L('回复更快，按更高的价格计费', 'Faster replies, billed at a higher rate')

export interface FastStatus {
  /** 开关能不能拨（已经开着的总能关掉） */
  available: boolean
  /** 开关下面那行字 */
  hint: string
  /** 提示是不是原因（开不了、冷却中），用警示色 */
  warn: boolean
  /** 开着但在冷却（限流后暂停），胶囊里的「快速」划掉 */
  cooldown: boolean
}

export function fastStatus(
  flags: Pick<SessionFlags, 'fastAvailable' | 'fastState' | 'fastBlocked'> | null,
): FastStatus {
  const reason = flags?.fastBlocked ?? null
  if (flags?.fastAvailable === false)
    return {
      available: false,
      hint: L(
        `暂时不可用：${(reason && FAST_BLOCKED()[reason]) || '原因未知'}`,
        `Unavailable: ${(reason && FAST_BLOCKED()[reason]) || 'unknown reason'}`,
      ),
      warn: true,
      cooldown: false,
    }
  if (flags?.fastState === 'cooldown')
    return {
      available: true,
      hint: L(
        'Fast 暂时不可用（冷却中），这段时间按普通速度回复，会自动恢复',
        'Fast is cooling down. Replies use normal speed for now and Fast resumes automatically',
      ),
      warn: true,
      cooldown: true,
    }
  return { available: true, hint: (reason && FAST_HINT()[reason]) || fastDefaultHint(), warn: false, cooldown: false }
}

/** 打开快速模式前的确认（关掉不用确认） */
export const fastConfirm = () =>
  L(
    '打开快速模式？回复更快，但按更高的价格计费。这个会话之后的每一轮都算，随时可以关掉。',
    'Turn on Fast mode? Replies are faster but billed at a higher rate. It applies to every following turn in this conversation, and you can turn it off anytime.',
  )

export function effortOptions(engine: EngineId, model: EngineModel | undefined, current: Effort | null): ModeOption[] {
  const efforts = model?.efforts.length ? model.efforts : (ENGINES[engine]?.caps.efforts ?? [])
  const labels = EFFORT()
  const out: ModeOption[] = [
    { value: '', label: L('默认', 'Default') },
    ...efforts.map(e => ({ value: e, label: labels[e] ?? e })),
  ]
  if (current && !efforts.includes(current)) out.push({ value: current, label: labels[current] ?? current })
  return out
}
