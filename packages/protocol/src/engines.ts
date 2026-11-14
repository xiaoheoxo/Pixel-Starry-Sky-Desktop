// 引擎描述 + 能力表（docs/engines.md §4）：纯数据，界面和引擎层共用
import type { EngineCaps, EngineId } from './types'

export interface EngineDescriptor {
  id: EngineId
  name: string
  short: string
  caps: EngineCaps
  /** 请求格式：messages（Anthropic 接口）、responses（OpenAI Responses 接口）或 gemini（Gemini 原生接口）；平台分组按它筛选 */
  wireApi: 'messages' | 'responses' | 'gemini'
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
      // 只回退 / 分叉对话（thread/revert、thread/fork），Codex 没有文件检查点：rewindCode 不开
      rewind: true,
      fork: true,
      // 旁聊：单次进程临时分叉（docs/ui/codex-sidechat.md）
      sideChat: true,
      liveModelSwitch: false,
      livePermissionSwitch: false,
      // 计划模式用 Codex 原生的计划协作模式，Fast 用服务档位 priority（docs/codex-engine.md §3.5）
      permissionModes: ['ask', 'edits', 'auto', 'plan', 'full'],
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
  // 自己的命令行智能体（packages/cli，基于 Pi，docs/own-cli.md）：能力先保守，回退 / 后台任务关着；
  // 旁聊复制 Pi 会话文件单独问一次（engine pixel/side.ts）
  pixel: {
    id: 'pixel',
    name: 'Pixel',
    short: 'Px',
    caps: {
      imageInput: true,
      interrupt: true,
      resume: true,
      steer: true,
      rewind: false,
      sideChat: true,
      // 模型 / 强度走 RPC set_model / set_thinking_level，权限模式走批准扩展的 /pixelsky-mode 命令，都是运行中实时生效
      liveModelSwitch: true,
      livePermissionSwitch: true,
      permissionModes: ['ask', 'edits', 'plan', 'full'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      ultracode: false,
      fast: true,
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
  // Google Antigravity CLI（agy acp，ACP 协议，docs/antigravity-engine.md）：能力按 P0 实测（§7）先保守；
  // 第一期还没有对话（P2 做），模型菜单里也还没有它的线路，只在设置 › 本机引擎里检测、安装
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    short: 'Ag',
    caps: {
      imageInput: true,
      interrupt: true,
      resume: true,
      // agy 运行中再发一条就引导当前这一轮，但 P0 没录过、还没接：先走宿主排队（docs/antigravity-engine.md §11）
      steer: false,
      rewind: false,
      fork: false,
      sideChat: false,
      // 模型、思考档位、模式都是会话选项，运行中改实时生效
      liveModelSwitch: true,
      livePermissionSwitch: true,
      // default / accept-edits / plan；完全放行是 agy 的 accept-edits 加我们替它回允许（不换进程，antigravity/session.ts）
      permissionModes: ['ask', 'edits', 'plan', 'full'],
      // 实际档位跟着模型变（3.1-pro 只有 low / high），P2 按会话选项给
      efforts: ['low', 'medium', 'high'],
      ultracode: false,
      fast: false,
      thinkingSummaries: false,
      backgroundTasks: false,
      agentTrace: false,
      promptSuggestions: false,
      // agy 只有允许一次 / 拒绝一次；「本会话不再询问」由我们的会话记住（antigravity/session.ts）
      alwaysScopes: ['session'],
      costUsd: false,
      // agy update
      selfUpdate: true,
      launchSettings: false,
      pluginCommands: false,
      platformSwitch: false,
    },
    wireApi: 'gemini',
    platformVendors: [],
    unlabeledGroups: false,
    accent: null,
    nativeModelPrefix: 'gemini-',
  },
}

export const ENGINE_ORDER: readonly EngineId[] = ['claude', 'codex', 'pixel', 'antigravity']

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
