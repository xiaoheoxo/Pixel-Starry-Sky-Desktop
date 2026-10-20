// 演示模式下的平台目录（--demo）。真实目录来自适配层 /v1/platform/groups（docs/ui/platform-groups.md）
import { ENGINES, type EngineCatalog, type EngineConfig, type EngineLocalConfig } from '@pixelsky/protocol'
import type { EngineLite } from '@/data/types'
import type { PlatformGroupInfo } from '../../../shared/types/platform-catalog'
import type { ProvidersState } from '../../../shared/types/providers'

export const demoPlatformGroups: PlatformGroupInfo[] = [
  {
    id: '11',
    name: 'Claude 官方线路',
    description: '直连官方，稳定',
    platform: 'anthropic',
    rate_multiplier: 1,
    billing_source: 'balance_only',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  },
  {
    id: '12',
    name: 'Pro 月卡',
    description: '订阅额度内不扣余额',
    platform: 'anthropic',
    rate_multiplier: 1,
    billing_source: 'plan_only',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  },
  {
    id: '13',
    name: '特价线路',
    description: '高峰期可能排队',
    platform: 'anthropic',
    rate_multiplier: 0.6,
    billing_source: 'balance_only',
    models: ['claude-sonnet-5-5', 'claude-haiku-4-5'],
  },
]

/** 演示模式下本机引擎的检测结果（设置 › 本机引擎） */
export const demoEngineStatus: EngineLite[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    status: 'ready',
    version: '2.1.291',
    // 演示「有新版本」提示（docs/ui/engine-update.md）
    latestVersion: '2.1.300',
    message: null,
    account: { email: 'linxia@example.com', plan: 'max' },
    // 订阅登录（claude.ai）：授权卡显示多账号（docs/ui/engine-accounts-claude.md）
    auth: { kind: 'login' },
    path: 'C:\\Users\\linxia\\.local\\bin\\claude.exe',
    caps: {
      permissionModes: ['ask', 'edits', 'plan', 'full'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      ultracode: true,
      fast: true,
      thinkingSummaries: true,
      selfUpdate: true,
      launchSettings: true,
      pluginCommands: true,
      platformSwitch: true,
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    // 演示「③ ChatGPT 授权」还没授权（docs/ui/model-channels.md §4.3）
    status: 'unauthenticated',
    version: '0.162.1',
    message: 'Codex is not signed in. Run codex login.',
    path: 'C:\\Users\\linxia\\AppData\\Roaming\\npm\\codex.cmd',
    caps: {
      permissionModes: ['ask', 'edits', 'full'],
      efforts: ['low', 'medium', 'high', 'xhigh'],
      ultracode: false,
      fast: true,
      thinkingSummaries: true,
      selfUpdate: false,
      launchSettings: false,
      pluginCommands: false,
      platformSwitch: false,
    },
  },
  {
    // 演示里也显示为已装好，方便截图（真实状态来自适配器的 checkLaunch）
    id: 'pixel',
    name: ENGINES.pixel.name,
    status: 'ready',
    version: '0.1.0',
    message: null,
    path: 'C:\\Users\\linxia\\AppData\\Roaming\\npm\\pixelsky.cmd',
    caps: {
      permissionModes: ['ask', 'edits', 'plan', 'full'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      ultracode: false,
      fast: false,
      thinkingSummaries: false,
      selfUpdate: false,
      launchSettings: false,
      pluginCommands: false,
      platformSwitch: false,
    },
  },
]

/** 演示模式下 Claude Code 报上来的输出风格（设置 › 本机引擎 › 对话） */
export const demoEngineCatalog: EngineCatalog = {
  outputStyles: ['default', 'Proactive', 'Concise', 'Explanatory', 'Learning'],
  currentOutputStyle: 'default',
  // 设置 › 本机引擎 › 上下文里的模型窗口列表
  models: [
    {
      id: 'opus',
      label: 'Opus',
      resolved: 'claude-opus-5-5',
      efforts: [],
      defaultEffort: null,
      inputModalities: [],
      isDefault: true,
    },
    {
      id: 'sonnet',
      label: 'Sonnet',
      resolved: 'claude-sonnet-5-5',
      efforts: [],
      defaultEffort: null,
      inputModalities: [],
      isDefault: false,
    },
  ],
}

/** 演示模式下 Codex 报上来的模型（和真机 Codex 0.162 的 model/list 一样的形状） */
const codexModel = (id: string, label: string, isDefault = false) => ({
  id,
  label,
  efforts: ['low', 'medium', 'high', 'xhigh'] as Array<'low' | 'medium' | 'high' | 'xhigh'>,
  defaultEffort: 'medium' as const,
  inputModalities: ['text', 'image'],
  isDefault,
})
export const demoCodexCatalog: EngineCatalog = {
  outputStyles: [],
  currentOutputStyle: null,
  models: [
    codexModel('gpt-6.1-sol', 'GPT-6.1-Sol', true),
    codexModel('gpt-6-astra', 'GPT-6-Astra'),
    codexModel('gpt-6-sol', 'GPT-6-Sol'),
    codexModel('gpt-6-luna', 'GPT-6-Luna'),
    codexModel('gpt-5.5', 'GPT-5.5'),
  ],
}

const demoLocal = (): EngineLocalConfig => ({
  path: null,
  args: [],
  env: {},
  compactModel: null,
  defaults: {
    model: null,
    effort: 'high',
    permissionMode: 'edits',
    ultracode: false,
    fast: false,
    thinkingSummaries: true,
  },
  outputStyle: null,
  contextWindows: { platform: {}, self: {} },
  askQuestions: true,
  autoCompactPct: null,
  hidden: false,
  rememberChoices: false,
})

/** 演示模式下本机引擎的配置（设置 › 本机引擎 › 详情；只改内存） */
export const demoEngineConfig: EngineConfig = { claude: demoLocal(), codex: demoLocal(), pixel: demoLocal() }

/** 演示用的两条自定义 API（docs/ui/custom-api.md §5 A4） */
export const demoProviders: ProvidersState = {
  persistent: true,
  warning: null,
  providers: [
    {
      id: 'demo-deepseek',
      name: 'DeepSeek 兼容',
      template: 'custom',
      protocol: 'anthropic',
      baseUrl: 'https://api.example.com/anthropic',
      auth: 'x-api-key',
      models: [{ id: 'deepseek-chat', priceRef: 'claude-haiku-4-5' }, { id: 'deepseek-reasoner' }],
      smallModel: 'deepseek-chat',
      modelFallback: true,
      keyHint: 'a1b2',
      headerNames: [],
      insecure: false,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
    },
    {
      id: 'demo-gateway',
      name: '公司网关',
      template: 'custom',
      protocol: 'responses',
      baseUrl: 'http://192.168.1.20:8080/v1',
      auth: 'bearer',
      models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }],
      smallModel: null,
      modelFallback: true,
      keyHint: '9f3c',
      headerNames: ['X-Org'],
      insecure: true,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
    },
  ],
}
