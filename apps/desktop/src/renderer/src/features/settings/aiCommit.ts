// AI 写提交信息的设置（docs/ui/ai-commit-codex-warnings-history.md §2.3）：保存在本机，多窗口同步。
// 写法（显示按钮、语言、写法、额外要求）随设置云同步；用哪条通道、线路、接口只在本机（自定义接口只在本机有）。
// 四条通道（docs/ui/ai-commit-channels.md）：没选过时按 Claude 授权 → 像素星空 → ChatGPT 授权 → 自定义接口 用第一条能用的
import { useSyncExternalStore } from 'react'
import { officialPrice, estimateCost } from '@pixelsky/protocol'
import type { AiCommitLanguage, AiCommitStyle, AiSource, AiUsage } from '../../../../shared/types/ai'
import type { ProviderView } from '../../../../shared/types/providers'
import type { EngineModel } from '@pixelsky/protocol'
import { groupsForModel, type PlatformGroup } from '@/features/account/platform'
import { channelState, type ChannelId, type ChannelState } from '@/features/model-channels/channelModel'

export interface AiCommitWriting {
  /** 在提交栏显示 AI 按钮 */
  enabled: boolean
  /** 在对话输入框显示「优化提示词」按钮（docs/ui/prompt-optimize.md），和提交信息共用通道 */
  promptButton: boolean
  language: AiCommitLanguage
  style: AiCommitStyle
  /** 额外要求，最多 INSTRUCTIONS_LIMIT 字 */
  instructions: string
}

export interface AiCommitModel {
  /** null：没选过，按通道状态自动选（defaultSource） */
  source: AiSource | null
  /** 云端的模型 */
  model: string
  /** 云端的线路；null 是自动（默认线路优先，再按倍率从低到高） */
  groupId: string | null
  /** 自定义 API 的接口和模型；null 用第一个接口 / 它的第一个模型 */
  providerId: string | null
  providerModel: string | null
  /** Claude 授权的模型别名；null 跟随 Claude Code 的设置 */
  claudeModel: string | null
  /** ChatGPT 授权的模型；null 跟随 Codex 的设置，CODEX_SMALL 是模型目录里第一个小模型（名字带 mini） */
  codexModel: string | null
}

export const AI_COMMIT_WRITING_KEY = 'pixelsky.aiCommit.writing'
export const AI_COMMIT_MODEL_KEY = 'pixelsky.aiCommit.model'
export const AI_COMMIT_DEFAULT_MODEL = 'claude-opus-5-5'
export const AI_COMMIT_CLAUDE_MODEL = 'haiku'
export const CODEX_SMALL = 'auto-mini'
export const INSTRUCTIONS_LIMIT = 1000
/** 没选过时按这个顺序用第一条能用的（§1 第 1 条）；也是菜单和设置页的排列顺序 */
export const COMMIT_ORDER: readonly AiSource[] = ['claude', 'platform', 'codex', 'custom']
/** 线路拒绝时最多换几条 */
const MAX_GROUPS = 3

export const DEFAULT_WRITING: AiCommitWriting = {
  enabled: true,
  promptButton: true,
  language: 'auto',
  style: 'body',
  instructions: '',
}
export const DEFAULT_MODEL: AiCommitModel = {
  source: null,
  model: AI_COMMIT_DEFAULT_MODEL,
  groupId: null,
  providerId: null,
  providerModel: null,
  claudeModel: AI_COMMIT_CLAUDE_MODEL,
  codexModel: CODEX_SMALL,
}

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v && v.length <= max ? v : null)

function parse(key: string): Record<string, unknown> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function readWriting(): AiCommitWriting {
  const v = parse(AI_COMMIT_WRITING_KEY)
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_WRITING.enabled,
    promptButton: typeof v.promptButton === 'boolean' ? v.promptButton : DEFAULT_WRITING.promptButton,
    language:
      v.language === 'zh' || v.language === 'en' || v.language === 'auto' ? v.language : DEFAULT_WRITING.language,
    style: v.style === 'subject' || v.style === 'body' ? v.style : DEFAULT_WRITING.style,
    instructions:
      typeof v.instructions === 'string' ? v.instructions.slice(0, INSTRUCTIONS_LIMIT) : DEFAULT_WRITING.instructions,
  }
}

export function readModel(): AiCommitModel {
  const v = parse(AI_COMMIT_MODEL_KEY)
  return {
    source: COMMIT_ORDER.includes(v.source as AiSource) ? (v.source as AiSource) : DEFAULT_MODEL.source,
    model: str(v.model) ?? DEFAULT_MODEL.model,
    groupId: typeof v.groupId === 'string' && /^\d{1,20}$/.test(v.groupId) ? v.groupId : null,
    providerId: str(v.providerId, 64),
    providerModel: str(v.providerModel),
    claudeModel: v.claudeModel === null ? null : (str(v.claudeModel) ?? DEFAULT_MODEL.claudeModel),
    codexModel: v.codexModel === null ? null : (str(v.codexModel) ?? DEFAULT_MODEL.codexModel),
  }
}

interface Snapshot {
  writing: AiCommitWriting
  model: AiCommitModel
}
let snapshot: Snapshot =
  typeof window === 'undefined'
    ? { writing: DEFAULT_WRITING, model: DEFAULT_MODEL }
    : { writing: readWriting(), model: readModel() }
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach(listener => listener())

function save(key: string, value: object): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 存储不可用时，本次仍然生效 */
  }
}

export function setAiCommitWriting(patch: Partial<AiCommitWriting>): void {
  const writing = { ...snapshot.writing, ...patch }
  writing.instructions = writing.instructions.slice(0, INSTRUCTIONS_LIMIT)
  snapshot = { ...snapshot, writing }
  save(AI_COMMIT_WRITING_KEY, writing)
  notify()
}

export function setAiCommitModel(patch: Partial<AiCommitModel>): void {
  snapshot = { ...snapshot, model: { ...snapshot.model, ...patch } }
  save(AI_COMMIT_MODEL_KEY, snapshot.model)
  notify()
}

function onStorage(event: StorageEvent): void {
  if (event.storageArea !== localStorage) return
  if (event.key !== AI_COMMIT_WRITING_KEY && event.key !== AI_COMMIT_MODEL_KEY && event.key !== null) return
  snapshot = { writing: readWriting(), model: readModel() }
  notify()
}

function subscribe(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}

const SERVER: Snapshot = { writing: DEFAULT_WRITING, model: DEFAULT_MODEL }
export function useAiCommitSettings(): Snapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER,
  )
}

// ---------------------------------------------------------------------------
// 纯函数：设置页和 Git 面板共用
// ---------------------------------------------------------------------------

/** 提交信息的通道 → 模型通道（文字、状态、修复按钮沿用模型通道那边的） */
export const COMMIT_CHANNEL: Record<AiSource, ChannelId> = {
  platform: 'platform',
  claude: 'claude',
  codex: 'chatgpt',
  custom: 'custom',
}

export interface CommitChannelContext {
  platform: Parameters<typeof channelState>[1]['platform']
  engines: Parameters<typeof channelState>[1]['engines']
  /** 有模型的自定义接口 */
  providers: unknown[]
  /** 当前在远程机器上：两条授权通道在本机跑，这边的引擎状态不是本机的，写的时候再报 */
  remote: boolean
}

export function commitChannelState(source: AiSource, ctx: CommitChannelContext): ChannelState {
  if ((source === 'claude' || source === 'codex') && ctx.remote) return { kind: 'ready' }
  return channelState(COMMIT_CHANNEL[source], ctx)
}

/** 能拿来写：ready；读取中也先列着（不放进「还没设置」） */
const usable = (state: ChannelState): boolean => state.kind === 'ready' || state.kind === 'loading'

/** 设置页和菜单的通道列表：能用的在前，没设置好的放到「还没设置」下面；各自按 COMMIT_ORDER */
export function commitChannels(ctx: CommitChannelContext): {
  ready: Array<{ source: AiSource; state: ChannelState }>
  unset: Array<{ source: AiSource; state: ChannelState }>
} {
  const all = COMMIT_ORDER.map(source => ({ source, state: commitChannelState(source, ctx) }))
  return { ready: all.filter(c => usable(c.state)), unset: all.filter(c => !usable(c.state)) }
}

/**
 * 没选过时用哪条：按顺序第一条能用或还在读取的（刚启动引擎还没检测完时先当 Claude 授权，不落到要花钱的通道上，
 * 真不能用写的时候会报）；都不能用时用像素星空（出错时提示登录）
 */
export function defaultSource(ctx: CommitChannelContext): AiSource {
  return COMMIT_ORDER.find(s => usable(commitChannelState(s, ctx))) ?? 'platform'
}

/** 这次用哪条：选过的照旧（哪怕现在不能用，写的时候报原因），没选过的自动 */
export const effectiveSource = (m: Pick<AiCommitModel, 'source'>, ctx: CommitChannelContext): AiSource =>
  m.source ?? defaultSource(ctx)

/** 订阅额度用完、没装、没授权时「这次改用 X」：除了这条以外第一条 ready 的 */
export function fallbackSource(failed: AiSource, ctx: CommitChannelContext): AiSource | null {
  return COMMIT_ORDER.find(s => s !== failed && commitChannelState(s, ctx).kind === 'ready') ?? null
}

/** ChatGPT 授权实际发的模型：CODEX_SMALL 换成目录里第一个名字带 mini 的，没有就跟随 Codex（null） */
export function commitCodexModel(stored: string | null, models: EngineModel[] | undefined): string | null {
  if (stored !== CODEX_SMALL) return stored
  return models?.find(m => /mini/i.test(m.id))?.id ?? null
}

/**
 * 云端按顺序试的线路（§2.3）：指定了就只用它；自动时默认线路（有这个模型）优先，再按倍率从低到高，最多 3 条。
 * groups 是支持 Claude 的线路（Anthropic 接口）
 */
export function commitGroups(
  groups: PlatformGroup[],
  model: string,
  pinned: string | null,
  preferred: string | null,
): string[] {
  const serving = groupsForModel(groups, model)
  if (pinned) return serving.some(g => g.id === pinned) ? [pinned] : []
  const first = serving.find(g => g.id === preferred)
  return [...(first ? [first] : []), ...serving.filter(g => g !== first)].slice(0, MAX_GROUPS).map(g => g.id)
}

/** 自定义 API：设置里选的接口和模型；接口删了或没选时用第一个有模型的接口 */
export function commitProvider(
  providers: ProviderView[],
  m: Pick<AiCommitModel, 'providerId' | 'providerModel'>,
): { provider: ProviderView; model: string } | null {
  const provider = providers.find(p => p.id === m.providerId && p.models.length) ?? providers.find(p => p.models.length)
  if (!provider) return null
  const model = provider.models.find(x => x.id === m.providerModel)?.id ?? provider.models[0].id
  return { provider, model }
}

/** 估算这次的费用（美元）：官方价 × 线路倍率；查不到价格时为 null */
export function estimateUsd(
  usage: AiUsage | null,
  model: string,
  multiplier = 1,
  priceRef?: string | null,
): number | null {
  if (!usage) return null
  const cost = estimateCost(usage, officialPrice(model, priceRef))
  return cost === null ? null : cost * multiplier
}
