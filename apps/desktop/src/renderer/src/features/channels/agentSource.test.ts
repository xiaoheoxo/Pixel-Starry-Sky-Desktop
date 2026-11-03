import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { PlatformGroup } from '@/features/account/platform'
import type { ProviderView } from '../../../../shared/types/providers'
import {
  applyDraft,
  memberDraftContext,
  modelChoices,
  modelForSource,
  pickRoute,
  platformModelsFor,
  platformRoutesFor,
  resolveRoute,
  settingsForSource,
  sourceKeyOf,
  sourceOptions,
  type DraftContext,
  type SourceContext,
} from './agentSource'

// AI 成员的额度来源：自有账号 / 像素星空平台 / 自定义接口（docs/ui/channels-local-ai.md §3.1 #1）

const group = (
  id: string,
  rate: number,
  models: string[],
  engines?: PlatformGroup['supported_engines'],
): PlatformGroup => ({
  id,
  name: id,
  description: '',
  platform: 'x',
  rate_multiplier: rate,
  billing_source: 'balance',
  models,
  modelsError: null,
  ...(engines ? { supported_engines: engines } : {}),
})
const provider = (id: string, protocol: ProviderView['protocol'], models: string[]): ProviderView =>
  ({ id, name: `接口 ${id}`, protocol, models: models.map(m => ({ id: m })) }) as unknown as ProviderView

const groups = [
  group('g-claude-cheap', 0.5, ['claude-sonnet-5-5'], ['claude']),
  group('g-claude', 1, ['claude-opus-5-5', 'claude-sonnet-5-5'], ['claude']),
  group('g-gpt', 1, ['gpt-5.5'], ['codex']),
]
const ctx: SourceContext = {
  email: 'me@example.com',
  groups,
  providers: [provider('anth', 'anthropic', ['my-claude']), provider('resp', 'responses', ['my-gpt', 'my-gpt-mini'])],
}
const own = [{ id: 'opus', label: 'Opus' }]

describe('来源选项', () => {
  it('自有账号、平台、这个引擎能用的接口；Claude Code 看不到 Responses 协议的接口', () => {
    expect(sourceOptions('claude', ctx).map(o => o.value)).toEqual(['self', 'platform', 'custom:anth'])
    expect(sourceOptions('codex', ctx).map(o => o.value)).toEqual(['self', 'platform', 'custom:resp'])
  })
  it('没登录像素星空：平台灰掉写「登录后可用」；平台上没有这个引擎的线路：灰掉写「没有线路」', () => {
    expect(sourceOptions('claude', { ...ctx, email: null })[1]).toMatchObject({ value: 'platform', disabled: 'signin' })
    const onlyGpt = { ...ctx, groups: [groups[2]] }
    expect(sourceOptions('claude', onlyGpt)[1]).toMatchObject({ disabled: 'no-route' })
    expect(sourceOptions('codex', onlyGpt)[1].disabled).toBeUndefined()
  })
  it('从已存的设置认出来源', () => {
    expect(sourceKeyOf(undefined)).toBe('self')
    expect(sourceKeyOf({ model: 'opus' })).toBe('self')
    expect(sourceKeyOf({ platform: { groupId: 'g', account: 'a' } })).toBe('platform')
    expect(sourceKeyOf({ provider: { id: 'anth' } })).toBe('custom:anth')
  })
})

describe('模型列表', () => {
  it('平台只列这个引擎能跑的模型（模型协议 + 线路声明）', () => {
    expect(platformModelsFor('claude', groups)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
    expect(platformModelsFor('codex', groups)).toEqual(['gpt-5.5'])
  })
  it('自有账号用引擎目录；自定义接口用接口里的模型', () => {
    expect(modelChoices('claude', 'self', ctx, own)).toEqual(own)
    expect(modelChoices('codex', 'custom:resp', ctx, own).map(m => m.id)).toEqual(['my-gpt', 'my-gpt-mini'])
  })
  it('换来源：模型还在列表里就保留，否则平台 / 接口取第一个，自有账号回到默认', () => {
    expect(modelForSource('claude', 'platform', 'claude-opus-5-5', ctx, own)).toBe('claude-opus-5-5')
    expect(modelForSource('claude', 'platform', 'opus', ctx, own)).toBe('claude-sonnet-5-5')
    expect(modelForSource('codex', 'custom:resp', 'my-gpt-mini', ctx, own)).toBe('my-gpt-mini')
    expect(modelForSource('codex', 'custom:resp', 'gpt-5.5', ctx, own)).toBe('my-gpt')
    expect(modelForSource('claude', 'self', 'claude-opus-5-5', ctx, own)).toBe('')
    expect(modelForSource('claude', 'self', 'opus', ctx, own)).toBe('opus')
  })
})

describe('存进成员配置的设置', () => {
  it('自有账号：只有模型（默认时什么都不写）', () => {
    expect(settingsForSource('claude', 'self', 'opus', ctx)).toEqual({ model: 'opus' })
    expect(settingsForSource('claude', 'self', '', ctx)).toEqual({})
  })
  it('平台：按模型取倍率最低、支持这个引擎的线路，记下登录的账号', () => {
    expect(settingsForSource('claude', 'platform', 'claude-sonnet-5-5', ctx)).toEqual({
      platform: { groupId: 'g-claude-cheap', account: 'me@example.com' },
      model: 'claude-sonnet-5-5',
    })
    expect(settingsForSource('claude', 'platform', 'claude-opus-5-5', ctx).platform?.groupId).toBe('g-claude')
    expect(settingsForSource('codex', 'platform', 'gpt-5.5', ctx).platform?.groupId).toBe('g-gpt')
  })
  it('自定义接口：记接口 id 和模型', () => {
    expect(settingsForSource('codex', 'custom:resp', 'my-gpt-mini', ctx)).toEqual({
      provider: { id: 'resp' },
      model: 'my-gpt-mini',
    })
  })
  it('平台没登录、没线路、接口删了：报错（界面已经灰掉，这里兜底）', () => {
    expect(() => settingsForSource('claude', 'platform', 'claude-opus-5-5', { ...ctx, email: null })).toThrow()
    expect(() => settingsForSource('claude', 'platform', 'x', { ...ctx, groups: [groups[2]] })).toThrow()
    expect(() => settingsForSource('claude', 'custom:gone', 'm', ctx)).toThrow()
  })
})

describe('平台线路', () => {
  it('只列这个引擎能用的线路，倍率低的在前', () => {
    const list = [groups[1], groups[2], groups[0]]
    expect(platformRoutesFor('claude', list).map(g => g.id)).toEqual(['g-claude-cheap', 'g-claude'])
  })
  it('选了线路：线路有这个模型就用它，没有就换到有这个模型、倍率最低的线路', () => {
    expect(resolveRoute('claude', groups, 'g-claude', 'claude-sonnet-5-5').groupId).toBe('g-claude')
    expect(resolveRoute('claude', groups, null, 'claude-sonnet-5-5').groupId).toBe('g-claude-cheap')
    expect(resolveRoute('claude', groups, 'g-claude-cheap', 'claude-opus-5-5').groupId).toBe('g-claude')
  })
  it('换到没有当前模型的线路：模型换成线路的第一个；线路用不了返回 null', () => {
    expect(pickRoute('claude', groups, 'g-claude-cheap', 'claude-opus-5-5')).toEqual({
      groupId: 'g-claude-cheap',
      model: 'claude-sonnet-5-5',
    })
    expect(pickRoute('claude', groups, 'g-claude', 'claude-opus-5-5')?.model).toBe('claude-opus-5-5')
    expect(pickRoute('claude', groups, 'g-gpt', 'claude-opus-5-5')).toBeNull()
  })
  it('存设置时用选的线路', () => {
    expect(settingsForSource('claude', 'platform', 'claude-sonnet-5-5', ctx, 'g-claude').platform?.groupId).toBe(
      'g-claude',
    )
  })
})

describe('一句话建成员：对到表单上', () => {
  const draftCtx: DraftContext = {
    ready: [
      { id: 'claude', name: 'Claude Code' },
      { id: 'codex', name: 'Codex', caps: { efforts: ['low', 'high'], fast: true, ultracode: false } },
    ],
    engine: 'claude',
    source: 'self',
    model: '',
    groupId: null,
    ownModels: own,
    sourceCtx: ctx,
    names: ['审查', 'Reviewer 2'],
  }

  it('引擎、来源、模型都能用：原样采纳，平台线路按模型挑', () => {
    const r = applyDraft(
      {
        engine: 'claude',
        source: 'platform',
        model: 'claude-opus-5-5',
        effort: 'high',
        reasons: { model: '要强一点' },
      },
      draftCtx,
    )
    expect(r.values).toEqual({ source: 'platform', model: 'claude-opus-5-5', groupId: 'g-claude' })
    expect(r.fields).toEqual({ engine: '', source: '', model: '要强一点' })
  })

  it('引擎没就绪、来源用不了、模型不在列表：退回去，不标「AI 填的」', () => {
    const r = applyDraft({ engine: 'pixel', source: 'custom:anth', model: 'nope', reasons: {} }, draftCtx)
    // pixel 没就绪留在 claude；anth 是 anthropic 协议 claude 能用，模型不在接口里换成接口的
    expect(r.values).toMatchObject({ source: 'custom:anth', model: 'my-claude' })
    expect(r.fields).toEqual({ source: '' })
    // 换到 codex：claude 的自有模型 opus 不认（codex 目录没加载），回到默认
    const s = applyDraft({ engine: 'codex', source: 'custom:anth', model: 'opus', reasons: {} }, draftCtx)
    expect(s.values).toMatchObject({ engine: 'codex', source: 'self', model: '', groupId: null })
    expect(s.fields).toEqual({ engine: '' })
  })

  it('模型不在列表里：表单原来的来源、模型、线路都不动', () => {
    const onPlatform = { ...draftCtx, source: 'platform' as const, model: 'claude-sonnet-5-5', groupId: 'g-claude' }
    const r = applyDraft({ name: '新人', model: 'gpt-5', reasons: {} }, onPlatform)
    expect(r.values).toEqual({ name: '新人' })
    // 来源换了但模型不对：模型按新来源取，不标「AI 填的」
    const s = applyDraft({ source: 'custom:anth', model: 'gpt-5', reasons: {} }, onPlatform)
    expect(s.values).toMatchObject({ source: 'custom:anth', model: 'my-claude', groupId: null })
    expect(s.fields).toEqual({ source: '' })
  })

  it('AI 要的是全权限：压成自动编辑，理由后面提示自己选', () => {
    const r = applyDraft({ permission: 'edits', fullAsked: true, reasons: { permission: '要跑命令' } }, draftCtx)
    expect(r.values.permission).toBe('edits')
    expect(r.fields.permission).toMatch(/^要跑命令 · /)
  })

  it('引擎用不了的推理强度、Fast、Ultracode 不认；没就绪的引擎不标', () => {
    const onCodex = { ...draftCtx, engine: 'codex' as const }
    const r = applyDraft({ effort: 'max', fast: true, ultracode: true, reasons: {} }, onCodex)
    expect(r.values).toEqual({ fast: true })
    expect(r.fields).toEqual({ fast: '' })
    // claude 的能力表没加载：表单不显示这几项，也不认
    expect(applyDraft({ effort: 'max', fast: true, reasons: {} }, draftCtx).fields).toEqual({})
    // 没有就绪的引擎：表单默认 claude，草稿也写 claude，不算 AI 填的
    expect(applyDraft({ engine: 'claude', reasons: {} }, { ...draftCtx, ready: [] }).fields).toEqual({})
  })

  it('没登录平台：平台来源不认，表单的来源不动', () => {
    const r = applyDraft({ source: 'platform', reasons: {} }, { ...draftCtx, sourceCtx: { ...ctx, email: null } })
    expect(r.values.source).toBeUndefined()
    expect(r.fields).toEqual({})
  })

  it('重名加数字后缀，不分大小写，不超过 40 字', () => {
    expect(applyDraft({ name: '审查', reasons: {} }, draftCtx).values.name).toBe('审查 2')
    expect(applyDraft({ name: 'reviewer', reasons: {} }, { ...draftCtx, names: ['Reviewer'] }).values.name).toBe(
      'reviewer 2',
    )
    const long = 'x'.repeat(40)
    expect(applyDraft({ name: long, reasons: {} }, { ...draftCtx, names: [long] }).values.name).toBe(
      `${'x'.repeat(38)} 2`,
    )
  })
})

describe('一句话建成员：给模型的可选项', () => {
  const draftCtx: DraftContext = {
    ready: [
      { id: 'claude', name: 'Claude Code' },
      { id: 'codex', name: 'Codex' },
    ],
    engine: 'claude',
    source: 'self',
    model: '',
    groupId: null,
    ownModels: own,
    sourceCtx: ctx,
    names: ['审查'],
  }

  it('每个模型只列一次，写明哪些来源能用', () => {
    const text = memberDraftContext(draftCtx, 8000)
    expect(text).toContain('- claude-sonnet-5-5: platform/claude')
    expect(text).toContain('- opus: self/claude')
    expect(text).toContain('- custom:resp: "接口 resp" (engines: codex)')
    expect(text).toContain('Existing member names (do not reuse): 审查')
    expect(text.match(/claude-sonnet-5-5/g)).toHaveLength(1)
  })

  it('超过预算截掉，写明还有几行', () => {
    const text = memberDraftContext(draftCtx, 200)
    expect(text.length).toBeLessThanOrEqual(200)
    expect(text).toMatch(/\(\d+ more not listed\)$/)
  })
})
