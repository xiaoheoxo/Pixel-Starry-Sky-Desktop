// AI 写提交信息的设置（docs/ui/ai-commit-codex-warnings-history.md §2.3）：读设置、选线路、选接口、估算费用
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformGroup } from '@/features/account/platform'
import type { ProviderView } from '../../../../shared/types/providers'
import {
  AI_COMMIT_MODEL_KEY,
  AI_COMMIT_WRITING_KEY,
  CODEX_SMALL,
  commitChannels,
  commitCodexModel,
  commitGroups,
  commitProvider,
  DEFAULT_MODEL,
  defaultSource,
  effectiveSource,
  fallbackSource,
  type CommitChannelContext,
  DEFAULT_WRITING,
  estimateUsd,
  readModel,
  readWriting,
} from './aiCommit'

const group = (id: string, rate: number, models: string[]): PlatformGroup =>
  ({ id, name: 'g' + id, rate_multiplier: rate, models, modelsError: null }) as PlatformGroup
const provider = (id: string, models: string[], keyHint: string | null = '1234'): ProviderView =>
  ({ id, name: id, models: models.map(m => ({ id: m })), keyHint }) as ProviderView

describe('读设置', () => {
  const data = new Map<string, string>()
  beforeEach(() => {
    data.clear()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  it('没有存过时用默认：显示按钮、跟随仓库、标题加正文、通道自动、云端 Opus 5.5、Claude Haiku、Codex 小模型', () => {
    expect(readWriting()).toEqual(DEFAULT_WRITING)
    expect(readModel()).toEqual(DEFAULT_MODEL)
    expect(DEFAULT_MODEL).toMatchObject({
      source: null,
      model: 'claude-opus-5-5',
      claudeModel: 'haiku',
      codexModel: CODEX_SMALL,
    })
  })
  it('选过的通道和「跟随引擎」（null）照存的读', () => {
    localStorage.setItem(
      AI_COMMIT_MODEL_KEY,
      JSON.stringify({ source: 'codex', claudeModel: null, codexModel: 'gpt-x' }),
    )
    expect(readModel()).toMatchObject({ source: 'codex', claudeModel: null, codexModel: 'gpt-x' })
    // 旧版本存的 platform 当成选过
    localStorage.setItem(AI_COMMIT_MODEL_KEY, JSON.stringify({ source: 'platform' }))
    expect(readModel()).toMatchObject({ source: 'platform', claudeModel: 'haiku' })
    localStorage.setItem(AI_COMMIT_MODEL_KEY, JSON.stringify({ source: 'gemini', codexModel: 3 }))
    expect(readModel()).toMatchObject({ source: null, codexModel: CODEX_SMALL })
  })
  it('不合法的值回到默认；额外要求最多 1000 字', () => {
    localStorage.setItem(
      AI_COMMIT_WRITING_KEY,
      JSON.stringify({ enabled: 'yes', language: 'fr', style: 'subject', instructions: 'x'.repeat(1200) }),
    )
    localStorage.setItem(AI_COMMIT_MODEL_KEY, JSON.stringify({ source: 'custom', groupId: '../x', model: 7 }))
    expect(readWriting()).toEqual({
      enabled: true,
      promptButton: true,
      language: 'auto',
      style: 'subject',
      instructions: 'x'.repeat(1000),
    })
    expect(readModel()).toMatchObject({ source: 'custom', groupId: null, model: 'claude-opus-5-5' })
    localStorage.setItem(AI_COMMIT_MODEL_KEY, '{not json')
    expect(readModel()).toEqual(DEFAULT_MODEL)
  })
})

describe('commitGroups', () => {
  const groups = [
    group('1', 1, ['claude-opus-5-5', 'claude-sonnet-5-5']),
    group('2', 0.5, ['claude-opus-5-5']),
    group('3', 0.8, ['claude-sonnet-5-5']),
    group('4', 2, ['claude-opus-5-5']),
    group('5', 0.9, ['claude-opus-5-5']),
  ]
  it('自动：默认线路有这个模型就先用它，再按倍率从低到高，最多 3 条', () => {
    expect(commitGroups(groups, 'claude-opus-5-5', null, '4')).toEqual(['4', '2', '5'])
    expect(commitGroups(groups, 'claude-opus-5-5', null, '3')).toEqual(['2', '5', '1'])
    expect(commitGroups(groups, 'claude-opus-5-5', null, null)).toEqual(['2', '5', '1'])
  })
  it('指定了线路就只用它；线路没有这个模型时为空', () => {
    expect(commitGroups(groups, 'claude-opus-5-5', '1', '2')).toEqual(['1'])
    expect(commitGroups(groups, 'claude-opus-5-5', '3', null)).toEqual([])
    expect(commitGroups(groups, 'claude-haiku-5-5', null, '1')).toEqual([])
  })
})

describe('commitProvider', () => {
  const list = [provider('empty', []), provider('a', ['m1', 'm2']), provider('b', ['n1'])]
  it('用设置里选的接口和模型；接口删了或没有模型时用第一个有模型的接口', () => {
    expect(commitProvider(list, { providerId: 'b', providerModel: 'n1' })).toMatchObject({
      provider: { id: 'b' },
      model: 'n1',
    })
    expect(commitProvider(list, { providerId: 'a', providerModel: 'gone' })?.model).toBe('m1')
    expect(commitProvider(list, { providerId: 'deleted', providerModel: null })?.provider.id).toBe('a')
    expect(commitProvider(list, { providerId: 'empty', providerModel: null })?.provider.id).toBe('a')
    expect(commitProvider([provider('x', [])], { providerId: null, providerModel: null })).toBeNull()
  })
})

describe('estimateUsd', () => {
  it('官方价乘线路倍率；没有用量或查不到价格时为 null', () => {
    const usage = { input: 20_000, output: 300, cacheRead: 0, cacheWrite: 0 }
    // Opus 5.5：输入 $4、输出 $20 / 百万 token
    expect(estimateUsd(usage, 'claude-opus-5-5')).toBeCloseTo(0.086, 6)
    expect(estimateUsd(usage, 'claude-opus-5-5', 0.5)).toBeCloseTo(0.043, 6)
    expect(estimateUsd(null, 'claude-opus-5-5')).toBeNull()
    expect(estimateUsd(usage, 'my-private-model')).toBeNull()
    expect(estimateUsd(usage, 'my-private-model', 1, 'claude-opus-5-5')).toBeCloseTo(0.086, 6)
  })
})

describe('通道', () => {
  type Status = 'ready' | 'unauthenticated' | 'missing'
  const ctx = (o: {
    email?: string | null
    claude?: Status
    codex?: Status
    /** 默认没装（真实环境检测完后每个引擎都在列表里） */
    agy?: Status
    providers?: number
    remote?: boolean
  }): CommitChannelContext => ({
    platform: { email: o.email ?? null, loaded: true, loading: false, groups: [group('1', 1, ['claude-opus-5-5'])] },
    engines: [
      ...(o.claude ? [{ id: 'claude' as const, status: o.claude, message: null }] : []),
      ...(o.codex ? [{ id: 'codex' as const, status: o.codex, message: null }] : []),
      { id: 'antigravity' as const, status: o.agy ?? 'missing', message: null },
    ],
    providers: Array.from({ length: o.providers ?? 0 }),
    remote: o.remote ?? false,
  })

  it('没选过：Claude 授权 → 像素星空 → ChatGPT 授权 → 自定义接口，用第一条能用的', () => {
    expect(defaultSource(ctx({ claude: 'ready', email: 'a@b', codex: 'ready' }))).toBe('claude')
    expect(defaultSource(ctx({ claude: 'unauthenticated', email: 'a@b', codex: 'ready' }))).toBe('platform')
    expect(defaultSource(ctx({ claude: 'missing', codex: 'ready', providers: 1 }))).toBe('codex')
    expect(defaultSource(ctx({ claude: 'missing', codex: 'unauthenticated', providers: 1 }))).toBe('custom')
    // 引擎还没检测完：先当 Claude 授权，不落到已经读好的自定义接口（要花钱）上
    expect(defaultSource(ctx({ providers: 1 }))).toBe('claude')
    // 都不能用：像素星空（写的时候提示登录）
    expect(defaultSource(ctx({ claude: 'missing', codex: 'missing' }))).toBe('platform')
  })

  it('选过的照旧，哪怕现在不能用', () => {
    const c = ctx({ claude: 'ready', codex: 'unauthenticated' })
    expect(effectiveSource({ source: 'codex' }, c)).toBe('codex')
    expect(effectiveSource({ source: null }, c)).toBe('claude')
  })

  it('列表：能用的在前，没设置好的放到后面，各自按顺序；引擎还没检测完的先列着', () => {
    const list = commitChannels(ctx({ codex: 'ready', email: null, providers: 2 }))
    expect(list.ready.map(c => c.source)).toEqual(['claude', 'codex', 'custom'])
    expect(list.ready[0].state.kind).toBe('loading')
    expect(list.unset.map(c => c.source)).toEqual(['platform', 'antigravity'])
  })

  it('远程机器上：三条授权通道（含 Google 账号）在本机跑，先当能用（写的时候再报）', () => {
    expect(commitChannels(ctx({ claude: 'missing', remote: true })).ready.map(c => c.source)).toEqual([
      'claude',
      'codex',
      'antigravity',
    ])
  })

  it('这次改用：除了失败的那条以外第一条能用的', () => {
    const c = ctx({ claude: 'ready', email: 'a@b', codex: 'ready' })
    expect(fallbackSource('claude', c)).toBe('platform')
    expect(fallbackSource('platform', c)).toBe('claude')
    expect(fallbackSource('claude', ctx({ claude: 'ready' }))).toBeNull()
  })

  it('Codex 小模型：目录里第一个名字带 mini 的，没有就跟随 Codex', () => {
    const models = [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    ] as Parameters<typeof commitCodexModel>[1]
    expect(commitCodexModel(CODEX_SMALL, models)).toBe('gpt-5.4-mini')
    expect(commitCodexModel(CODEX_SMALL, [])).toBeNull()
    expect(commitCodexModel(CODEX_SMALL, undefined)).toBeNull()
    expect(commitCodexModel('gpt-5.5', models)).toBe('gpt-5.5')
    expect(commitCodexModel(null, models)).toBeNull()
  })
})
