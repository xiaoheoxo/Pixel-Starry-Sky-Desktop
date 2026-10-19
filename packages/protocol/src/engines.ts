// 引擎描述 + 能力表（docs/engines.md §4）：纯数据，界面和引擎层共用
import type { EngineCaps, EngineId } from './types'

export interface EngineDescriptor {
  id: EngineId
  name: string
  short: string
  caps: EngineCaps
  /** 请求格式：messages（Anthropic 接口）或 responses（OpenAI Responses 接口）；平台分组按它筛选 */
  wireApi: 'messages' | 'responses'
  /** 平台目录里属于这个引擎的供应商名（小写），例如 anthropic、openai */
  platformVendors: string[]
  /** 平台分组没有写平台字段时，是否算作这个引擎（旧目录兼容） */
  unlabeledGroups: boolean
  /** 品牌强调色（CSS 变量或颜色值），没有就是 null */
  accent: string | null
  /** 本机模型名的前缀，用来判断一个模型名是不是这个引擎认识的；没有前缀约定就是 null */
  nativeModelPrefix: string | null
}

export const ENGINES: Record<EngineId, EngineDescriptor> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    short: 'Cc',
    caps: {
      imageInput: true,
      interrupt: true,
      resume: true,
      steer: false,
      rewind: true,
      rewindCode: true,
      fork: true,
      sideChat: true,
      liveModelSwitch: true,
      livePermissionSwitch: true,
      permissionModes: ['ask', 'edits', 'plan', 'full'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      ultracode: true,
      fast: true,
      thinkingSummaries: true,
      backgroundTasks: true,
      agentTrace: true,
      promptSuggestions: true,
      alwaysScopes: ['session', 'project', 'user'],
      costUsd: true,
      selfUpdate: true,
      launchSettings: true,
      pluginCommands: true,
      platformSwitch: true,
    },
    wireApi: 'messages',
    platformVendors: ['anthropic', 'claude'],
    unlabeledGroups: true,
    accent: 'var(--engine-claude)',
    nativeModelPrefix: 'claude-',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    short: 'Cx',
    caps: {
      imageInput: true,
      interrupt: true,
      resume: true,
      steer: true,
      // 只回退 / 分叉对话（thread/revert、thread/fork），Codex 没有文件检查点：rewindCode、sideChat 不开
      rewind: true,
      fork: true,
      liveModelSwitch: false,
      livePermissionSwitch: false,
      // 计划模式用 Codex 原生的计划协作模式，Fast 用服务档位 priority（docs/codex-engine.md §3.5）
      permissionModes: ['ask', 'edits', 'plan', 'full'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      ultracode: false,
      fast: true,
      thinkingSummaries: true,
      backgroundTasks: false,
      agentTrace: true,
      promptSuggestions: false,
      alwaysScopes: ['session'],
      costUsd: false,
      // npm 装的 Codex 用 npm install -g 更新（其他装法给出原因）
      selfUpdate: true,
      launchSettings: false,
      pluginCommands: false,
      platformSwitch: false,
    },
    wireApi: 'responses',
    platformVendors: ['openai'],
    unlabeledGroups: false,
    accent: null,
    nativeModelPrefix: null,
  },
  // 自己的命令行智能体（packages/cli，基于 Pi，docs/own-cli.md）：能力先保守，和 Codex 一样回退 / 旁聊 / 后台任务关着
  pixel: {
    id: 'pixel',
    name: '像素星空',
    short: 'Px',
    caps: {
      imageInput: true,
      interrupt: true,
      resume: true,
      steer: true,
      rewind: false,
      // 模型 / 强度走 RPC set_model / set_thinking_level，权限模式走批准扩展的 /pixelsky-mode 命令，都是运行中实时生效
      liveModelSwitch: true,
      livePermissionSwitch: true,
      permissionModes: ['ask', 'edits', 'plan', 'full'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      ultracode: false,
      fast: false,
      thinkingSummaries: false,
      backgroundTasks: false,
      // 子智能体（命令行的 task 工具）：进度从工具的 details 来，重新打开时读 Pi 会话文件
      agentTrace: true,
      promptSuggestions: false,
      // 批准扩展三选一：允许 / 本会话不再询问 / 拒绝（规则记在 Pi 会话文件里，续接后照样生效）
      alwaysScopes: ['session'],
      costUsd: true,
      // 命令行跟着桌面端一起更新，不自更新
      selfUpdate: false,
      launchSettings: false,
      pluginCommands: false,
      platformSwitch: false,
    },
    wireApi: 'messages',
    // Messages（anthropic / claude 线路）和 Responses（openai 线路）都会说；自定义 API 里还能用 Chat Completions
    platformVendors: ['anthropic', 'claude', 'openai'],
    unlabeledGroups: false,
    accent: null,
    nativeModelPrefix: null,
  },
}

export const ENGINE_ORDER: readonly EngineId[] = ['claude', 'codex', 'pixel']

/** 版本号 a 是否比 b 新（按点分的数字逐段比，-beta 之类的后缀不计） */
export function isNewerVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map(x => parseInt(x, 10) || 0)
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map(x => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i]
  return false
}
