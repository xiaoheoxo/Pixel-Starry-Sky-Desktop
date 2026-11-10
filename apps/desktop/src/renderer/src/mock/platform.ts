// 演示模式下的平台目录（--demo）。真实目录来自适配层 /v1/platform/groups（docs/ui/platform-groups.md）
import { ENGINES, type EngineCatalog, type EngineConfig, type EngineLocalConfig } from '@pixelsky/protocol'
import type { EngineLite } from '@/data/types'
import type { PlatformGroupInfo, PlatformGroupKey, PlatformKeyMode } from '../../../shared/types/platform-catalog'
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

/** 演示用户在网站上自己建过 Key 的线路（Pro 月卡没建过） */
const DEMO_OWN_KEYS: Record<string, string> = { '11': '工作用', '13': 'Pixel CLI · default' }

/**
 * 每条线路按「扣费用的 Key」会记在哪把 Key 上（docs/ui/platform-key-mode.md）：
 * 自动都是客户端专用的托管 Key；我的 Key 有用户的就用它，没有的线路仍是托管 Key
 */
export function demoPlatformKeys(mode: PlatformKeyMode): Record<string, PlatformGroupKey> {
  return Object.fromEntries(
    demoPlatformGroups.map(g => {
      const own = DEMO_OWN_KEYS[g.id]
      const key =
        mode === 'own' && own ? { name: own, own: true } : { name: `像素星空 · ${g.name} · 演示电脑`, own: false }
      return [g.id, key]
    }),
  )
}

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
    account: { email: 'linxia@example.com', plan: 'max_20x' },
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
      permissionModes: ['ask', 'edits', 'auto', 'full'],
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
  autoPlan: true,
  autoCompactPct: null,
  hidden: false,
  rememberChoices: false,
  peerMessages: false,
  peekSessions: 'off',
  subagentModel: null,
  subagentEffort: null,
  inputPrediction: 'off',
  resetCreditAuto: null,
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
    {
      // OpenAI Chat 协议的中转：「看图」有自动判断的各种情况，也有手动指定的
      id: 'demo-grok-relay',
      name: 'Grok 中转',
      template: 'custom',
      protocol: 'chat',
      baseUrl: 'https://relay.example.com/v1',
      auth: 'bearer',
      models: [
        { id: 'grok-4.7-fast-reasoning' },
        { id: 'grok-4', images: true },
        { id: 'xai/grok-4.7' },
        { id: 'qwen3-vl-plus' },
        { id: 'grok-code-fast-1' },
      ],
      smallModel: null,
      modelFallback: true,
      keyHint: '7c1e',
      headerNames: [],
      insecure: false,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
    },
  ],
}
