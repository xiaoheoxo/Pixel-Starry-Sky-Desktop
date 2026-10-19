import { tr } from '../../i18n/core'
// 引擎相关的显示文字（中文）
import {
  ENGINES,
  type Effort,
  type EngineId,
  type EngineModel,
  type FileChange,
  type PermissionMode,
} from '@pixelsky/protocol'
import type { ChangedFiles } from '@/data/types'

/** 推理强度用英文（和 JuCode 桌面版、Claude Code 一致） */
export const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  ultra: 'Ultra',
}

/** 新会话默认的推理强度，也是「恢复默认」按钮回到的档位 */
export const DEFAULT_EFFORT: Effort = 'high'

export function effortLabel(e: Effort | null): string {
  return e ? EFFORT_LABEL[e] : 'Default'
}

/** 推理强度的强调色：引擎（模型）的品牌色，和 JuCode modelColor 一致；没有品牌色的引擎用正文色（空字符串） */
export function engineAccent(engine: EngineId): string {
  return ENGINES[engine].accent ?? ''
}

/** Fast 模式开不了的原因（CLI 的 fast_mode_disabled_reason） */
const FAST_BLOCKED: Record<string, string> = {
  get free() {
    return tr('engine.labels.unavailableForFreeAccounts')
  },
  get preference() {
    return tr('engine.labels.fastModeIsNot')
  },
  get extra_usage_disabled() {
    return tr('engine.labels.extraUsageIsNot')
  },
  get network_error() {
    return tr('engine.labels.networkError')
  },
  get not_first_party() {
    return tr('engine.labels.onlySupportedByOfficial')
  },
  get disabled_by_env() {
    return tr('engine.labels.disabledByEnvironmentVariable')
  },
  get model_not_allowed() {
    return tr('session.ComposerMenus.notSupportedByThis')
  },
  get pending() {
    return tr('engine.labels.checkingAccountStatus')
  },
}

export function fastBlockedText(reason: string): string {
  return FAST_BLOCKED[reason] ?? tr('engine.labels.temporarilyUnavailable')
}

/** Fast 能开、但可能不生效时的提示（Codex 不设门禁，docs/codex-engine.md §3.5）；不认识的原因不提示 */
const FAST_HINT: Record<string, string> = {
  get codex_gateway() {
    return tr('codex.fastGateway')
  },
  get codex_unverified() {
    return tr('codex.fastUnverified')
  },
}

export function fastHintText(reason: string): string | null {
  return FAST_HINT[reason] ?? null
}

/** 后台任务类型名 */
export function taskKindLabel(kind: string): string {
  if (kind.startsWith('local_workflow')) return tr('engine.labels.multiAgentOrchestration')
  if (kind.startsWith('local_bash')) return tr('engine.labels.backgroundCommand')
  if (kind.startsWith('local_agent')) return tr('engine.labels.subagent')
  if (kind.startsWith('monitor')) return tr('engine.labels.monitorTask')
  return tr('engine.labels.backgroundTask')
}

export const PERMISSION_INFO: Record<PermissionMode, { label: string; hint: string }> = {
  ask: {
    get label() {
      return tr('engine.labels.askEveryTime')
    },
    get hint() {
      return tr('engine.labels.askBeforeEditingFiles')
    },
  },
  edits: {
    get label() {
      return tr('engine.labels.autoEdit')
    },
    get hint() {
      return tr('engine.labels.editProjectFilesAutomatically')
    },
  },
  plan: {
    get label() {
      return tr('engine.labels.planMode')
    },
    get hint() {
      return tr('engine.labels.readOnlyProposePlan')
    },
  },
  full: {
    get label() {
      return tr('engine.labels.fullAccess')
    },
    get hint() {
      return tr('engine.labels.executeWithoutAskingUse')
    },
  },
}

/** 引擎专属的权限说明（覆盖 PERMISSION_INFO 的通用说明）；没写的模式用通用说明 */
export const PERMISSION_HINTS: Partial<Record<EngineId, Partial<Record<PermissionMode, () => string>>>> = {
  codex: {
    ask: () => tr('codex.permission.ask'),
    edits: () => tr('codex.permission.edits'),
    plan: () => tr('codex.permission.plan'),
  },
}

/** 侧边栏右侧的相对时间：刚刚 / 5分钟 / 3小时 / 2天 / 10-05 */
export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000)
  if (s < 60) return tr('account.format.justNow')
  if (s < 3600) return tr('engine.labels.m', { p0: Math.floor(s / 60) })
  if (s < 86400) return tr('engine.labels.h', { p0: Math.floor(s / 3600) })
  if (s < 86400 * 30) return tr('engine.labels.d', { p0: Math.floor(s / 86400) })
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 统一协议的文件改动 → 「改动文件」卡片的数据（同一个文件多次改动合并） */
export function toChangedFiles(changes: FileChange[]): ChangedFiles | null {
  if (changes.length === 0) return null
  const byPath = new Map<string, { added: number; removed: number; newText?: string; diffs?: string[] }>()
  for (const c of changes) {
    const prev = byPath.get(c.path) ?? { added: 0, removed: 0 }
    const diffs = c.diff ? [...(prev.diffs ?? []), c.diff] : prev.diffs
    byPath.set(c.path, {
      added: prev.added + c.added,
      removed: prev.removed + c.removed,
      ...(c.newText ? { newText: c.newText } : prev.newText ? { newText: prev.newText } : {}),
      ...(diffs ? { diffs } : {}),
    })
  }
  const files = [...byPath].map(([path, n]) => {
    const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return { dir: i >= 0 ? path.slice(0, i + 1) : '', name: i >= 0 ? path.slice(i + 1) : path, ...n }
  })
  return {
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    files,
  }
}

/**
 * 自有额度时可选的模型：引擎命令行认识的别名（Claude Code `--model opus` 等），null 表示跟随引擎自己的设置。
 * 平台额度的模型来自分组目录，不在这里（docs/ui/source-switch.md §3.2）。
 */
export const SELF_MODELS: Record<EngineId, Array<{ value: string | null; label: string; hint: string }>> = {
  claude: [
    {
      value: null,
      get label() {
        return tr('engine.labels.default')
      },
      get hint() {
        return tr('engine.labels.useClaudeCodeSettings')
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      get hint() {
        return tr('engine.labels.latestOpus')
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      get hint() {
        return tr('engine.labels.latestSonnet')
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      get hint() {
        return tr('engine.labels.latestHaiku')
      },
    },
  ],
  codex: [
    {
      value: null,
      get label() {
        return tr('engine.labels.default')
      },
      get hint() {
        return tr('engine.labels.useCodexSettings')
      },
    },
  ],
  // 像素星空：模型来自命令行报上来的目录（catalog.models），没有写死的别名
  pixel: [
    {
      value: null,
      get label() {
        return tr('engine.labels.default')
      },
      get hint() {
        return tr('engine.pixel.useSettings')
      },
    },
  ],
}

/**
 * 自有额度的模型菜单：第一项是「默认」（value null）；有引擎目录（catalog.models）就用目录，
 * 没读到目录时退回 SELF_MODELS 里写死的别名；按 value 去重。
 */
export function selfModelOptions(
  engine: EngineId,
  catalogModels: EngineModel[] | undefined,
): Array<{ value: string | null; label: string; hint: string }> {
  const [defaultRow, ...aliases] = SELF_MODELS[engine]
  const fromCatalog = (catalogModels ?? []).map(m => ({ value: m.id, label: m.label, hint: m.description || m.id }))
  const seen = new Set<string | null>()
  return [defaultRow, ...(fromCatalog.length > 0 ? fromCatalog : aliases)].filter(m => {
    if (seen.has(m.value)) return false
    seen.add(m.value)
    return true
  })
}

/** 自有模型的显示名：引擎目录里有就用目录的名字，其次别名表，完整模型名原样显示 */
export function selfModelLabel(engine: EngineId, model: string | null, catalogModels?: EngineModel[]): string {
  return (
    catalogModels?.find(m => m.id === model)?.label ??
    SELF_MODELS[engine].find(m => m.value === model)?.label ??
    model ??
    tr('engine.labels.default')
  )
}
