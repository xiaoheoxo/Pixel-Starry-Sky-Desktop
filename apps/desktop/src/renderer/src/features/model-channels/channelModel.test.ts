import { describe, expect, it } from 'vitest'
import type { EngineId, EngineStatus } from '@pixelsky/protocol'
import type { PlatformGroup } from '@/features/account/platform'
import {
  buildChannelMenu,
  channelOf,
  channelState,
  executorKey,
  executorsFor,
  parseExecutorMemory,
  parseNewTask,
  pickExecutor,
  pixelSelfMissing,
  selfSourceReady,
  sourceOfChannel,
  type MenuInput,
} from './channelModel'

function group(id: string, platform: string, models: string[], extra: Partial<PlatformGroup> = {}): PlatformGroup {
  return {
    id,
    name: `g${id}`,
    description: '',
    platform,
    rate_multiplier: 1,
    billing_source: 'balance_only',
    models,
    modelsError: null,
    ...extra,
  }
}

const groups = [
  group('a', 'anthropic', ['claude-opus-5-5', 'claude-sonnet-5-5']),
  group('o', 'openai', ['gpt-6.1-sol'], { supported_engines: ['codex', 'pixel'] }),
]
const providers = [
  { id: 'relay', protocol: 'anthropic' as const, models: [{ id: 'claude-sonnet-5-5' }] },
  { id: 'oa', protocol: 'responses' as const, models: [{ id: 'gpt-6.1' }] },
  { id: 'ds', protocol: 'chat' as const, models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] },
]
const engines = (s: Partial<Record<EngineId, EngineStatus>> = {}) =>
  (['claude', 'codex', 'pixel'] as const).map(id => ({ id, status: s[id] ?? ('ready' as EngineStatus), message: null }))

describe('通道和现有存储互相换算（docs/ui/model-channels.md §4.1）', () => {
  it('引擎 + 来源 → 通道', () => {
    expect(channelOf('claude', 'platform')).toBe('platform')
    expect(channelOf('codex', 'platform')).toBe('platform')
    expect(channelOf('claude', 'self')).toBe('claude')
    expect(channelOf('codex', 'self')).toBe('chatgpt')
    expect(channelOf('pixel', 'custom')).toBe('custom')
    // 像素星空 + 自有没有对应的通道
    expect(channelOf('pixel', 'self')).toBe('custom')
    expect(sourceOfChannel('chatgpt')).toBe('self')
    expect(sourceOfChannel('platform')).toBe('platform')
  })

  it('像素星空的自有（命令行自己配的 Key）：目录里有模型才算能用，没读到时按不能用', () => {
    expect(selfSourceReady('pixel', { models: [{ id: 'anthropic/claude-x' } as never] })).toBe(true)
    expect(selfSourceReady('pixel', { models: [] })).toBe(false)
    expect(selfSourceReady('pixel', null)).toBe(false)
    expect(selfSourceReady('pixel', {})).toBe(false)
    // Claude Code / Codex 的自有是它们自己的登录，由引擎状态另外提示
    expect(selfSourceReady('claude', null)).toBe(true)
    expect(selfSourceReady('codex', { models: [] })).toBe(true)
  })

  it('像素星空用自有但一个模型都没有：提示条要说；目录没读到 / 命令行没起来不算', () => {
    expect(pixelSelfMissing('pixel', 'self', { models: [] })).toBe(true)
    expect(pixelSelfMissing('pixel', 'self', null)).toBe(false)
    expect(pixelSelfMissing('pixel', 'self', {})).toBe(false)
    expect(pixelSelfMissing('pixel', 'self', { models: [{ id: 'openai/gpt-x' } as never] })).toBe(false)
    expect(pixelSelfMissing('pixel', 'platform', { models: [] })).toBe(false)
    expect(pixelSelfMissing('claude', 'self', { models: [] })).toBe(false)
  })
})

describe('谁来执行（§2.5）', () => {
  const ctx = { groups, providers }
  it('官方模型交给官方工具，像素星空排后面', () => {
    expect(executorsFor({ channel: 'platform', model: 'claude-opus-5-5', providerId: null }, ctx)).toEqual([
      'claude',
      'pixel',
    ])
    expect(executorsFor({ channel: 'platform', model: 'gpt-6.1-sol', providerId: null }, ctx)).toEqual([
      'codex',
      'pixel',
    ])
    expect(executorsFor({ channel: 'claude', model: null, providerId: null }, ctx)).toEqual(['claude'])
    expect(executorsFor({ channel: 'chatgpt', model: 'gpt-6.1', providerId: null }, ctx)).toEqual(['codex'])
  })
  it('自定义按协议；Chat 只有像素星空能跑', () => {
    const t = (providerId: string) => executorsFor({ channel: 'custom', model: null, providerId }, ctx)
    expect(t('relay')).toEqual(['claude', 'pixel'])
    expect(t('oa')).toEqual(['codex', 'pixel'])
    expect(t('ds')).toEqual(['pixel'])
    expect(t('gone')).toEqual([])
  })
  it('线路同时声明两个官方引擎时，GPT 仍只给 Codex，Claude 只给 Claude Code', () => {
    const mixed = [
      group('both', 'openai', ['gpt-6-astra', 'gpt-6.1-sol', 'claude-opus-5-5'], {
        supported_engines: ['claude', 'codex'],
        supported_apis: ['messages', 'responses'],
      }),
    ]
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol'])
      expect(executorsFor({ channel: 'platform', model, providerId: null }, { groups: mixed, providers })).toEqual([
        'codex',
        'pixel',
      ])
    expect(
      executorsFor({ channel: 'platform', model: 'claude-opus-5-5', providerId: null }, { groups: mixed, providers }),
    ).toEqual(['claude', 'pixel'])
  })
  it('线路只写了 Claude Code 的模型，像素星空也能跑；目录里没有的模型谁都不能跑', () => {
    const only = [group('c', 'anthropic', ['claude-haiku-5-5'], { supported_engines: ['claude'] })]
    expect(
      executorsFor({ channel: 'platform', model: 'claude-haiku-5-5', providerId: null }, { groups: only, providers }),
    ).toEqual(['claude', 'pixel'])
    expect(executorsFor({ channel: 'platform', model: 'nope', providerId: null }, ctx)).toEqual([])
  })

  it('默认用第一个；记住的还能跑就用记住的', () => {
    const pick = pickExecutor(['claude', 'pixel'], { channel: 'platform', engines: engines() })
    expect(pick).toEqual({ engine: 'claude', options: ['claude', 'pixel'], fallbackFrom: null, unavailable: false })
    expect(
      pickExecutor(['claude', 'pixel'], { channel: 'platform', engines: engines(), remembered: 'pixel' }).engine,
    ).toBe('pixel')
    // 记住的不在候选里（比如换了协议）：照默认
    expect(
      pickExecutor(['claude', 'pixel'], { channel: 'platform', engines: engines(), remembered: 'codex' }).engine,
    ).toBe('claude')
  })
  it('默认的没装：自动换成能跑的，并标出来', () => {
    const pick = pickExecutor(['claude', 'pixel'], { channel: 'platform', engines: engines({ claude: 'missing' }) })
    expect(pick).toEqual({ engine: 'pixel', options: ['pixel'], fallbackFrom: 'claude', unavailable: false })
  })
  it('平台和自定义不需要引擎自己登录；授权通道要', () => {
    expect(
      pickExecutor(['claude', 'pixel'], { channel: 'platform', engines: engines({ claude: 'unauthenticated' }) })
        .engine,
    ).toBe('claude')
    expect(pickExecutor(['claude'], { channel: 'claude', engines: engines({ claude: 'unauthenticated' }) })).toEqual({
      engine: 'claude',
      options: [],
      fallbackFrom: null,
      unavailable: true,
    })
  })
  it('都跑不了：还是写默认的那个，标成不可用', () => {
    const pick = pickExecutor(['pixel'], { channel: 'custom', engines: engines({ pixel: 'unsupported' }) })
    expect(pick).toEqual({ engine: 'pixel', options: [], fallbackFrom: null, unavailable: true })
  })
  it('已开始的对话沿用当前引擎（能跑就不换），盖过记住的；跑不了才按默认选', () => {
    const base = { channel: 'platform' as const, engines: engines() }
    expect(pickExecutor(['claude', 'pixel'], { ...base, current: 'pixel', remembered: 'claude' }).engine).toBe('pixel')
    expect(pickExecutor(['codex', 'pixel'], { ...base, current: 'claude' }).engine).toBe('codex')
    // 当前引擎没装：不沿用
    expect(
      pickExecutor(['claude', 'pixel'], { ...base, engines: engines({ claude: 'missing' }), current: 'claude' }).engine,
    ).toBe('pixel')
  })
  it('记执行者的键：平台按模型、自定义按接口，授权通道不记', () => {
    expect(executorKey({ channel: 'platform', model: 'm', providerId: null })).toBe('platform:m')
    expect(executorKey({ channel: 'custom', model: 'm', providerId: 'p' })).toBe('custom:p')
    expect(executorKey({ channel: 'claude', model: 'opus', providerId: null })).toBeNull()
  })
})

describe('通道状态', () => {
  const platform = { email: 'a@b.c', loaded: true, loading: false, groups }
  it('① 没登录 / 读取中 / 没有模型', () => {
    expect(
      channelState('platform', { platform: { ...platform, email: null }, engines: engines(), providers }).kind,
    ).toBe('signin')
    expect(
      channelState('platform', { platform: { ...platform, loaded: false }, engines: engines(), providers }).kind,
    ).toBe('loading')
    expect(
      channelState('platform', { platform: { ...platform, groups: [] }, engines: engines(), providers }).kind,
    ).toBe('no-route')
    expect(channelState('platform', { platform, engines: engines(), providers }).kind).toBe('ready')
  })
  it('②③ 跟着引擎状态；引擎还没检测出来算读取中', () => {
    const s = (st: EngineStatus) =>
      channelState('chatgpt', { platform, engines: engines({ codex: st }), providers }).kind
    expect(s('ready')).toBe('ready')
    expect(s('unauthenticated')).toBe('auth')
    expect(s('missing')).toBe('missing')
    expect(s('outdated')).toBe('outdated')
    expect(s('error')).toBe('error')
    expect(channelState('claude', { platform, engines: [], providers }).kind).toBe('loading')
  })
  it('④ 没接口', () => {
    expect(channelState('custom', { platform, engines: engines(), providers: [] }).kind).toBe('empty')
  })
})

describe('菜单（§2.3）', () => {
  const input = (patch: Partial<MenuInput> = {}): MenuInput => ({
    selection: { channel: 'platform', model: 'claude-opus-5-5', providerId: null },
    current: null,
    platform: { email: 'a@b.c', loaded: true, loading: false, groups, hiddenModels: [] },
    selfModels: { claude: [{ value: null }, { value: 'opus' }], chatgpt: [{ value: null }], google: [{ value: null }] },
    providers,
    engines: engines(),
    remembered: {},
    ...patch,
  })

  it('四组按顺序，选中的打勾，每行带执行者', () => {
    const menu = buildChannelMenu(input())
    expect(menu.map(g => g.channel)).toEqual(['platform', 'claude', 'chatgpt', 'google', 'custom'])
    const platform = menu[0].rows
    expect(platform.map(r => r.target.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol'])
    expect(platform.map(r => r.selected)).toEqual([true, false, false])
    expect(platform.map(r => r.pick.engine)).toEqual(['claude', 'claude', 'codex'])
    expect(menu[4].rows.map(r => r.pick.engine)).toEqual(['claude', 'codex', 'pixel'])
  })
  it('隐藏的平台模型不列，正在用的照常列', () => {
    const menu = buildChannelMenu(
      input({ platform: { ...input().platform, hiddenModels: ['claude-opus-5-5', 'gpt-6.1-sol'] } }),
    )
    expect(menu[0].rows.map(r => r.target.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
  })
  it('没授权的通道没有行（界面写「去授权」）', () => {
    const menu = buildChannelMenu(input({ engines: engines({ codex: 'unauthenticated' }) }))
    expect(menu[2]).toMatchObject({ state: { kind: 'auth' }, rows: [] })
  })
  it('已开始的对话：沿用当前引擎，但别的引擎能跑的行也不灰（选了会换引擎）', () => {
    const menu = buildChannelMenu(input({ current: 'claude' }))
    expect(menu[0].rows.map(r => r.pick.engine)).toEqual(['claude', 'claude', 'codex'])
    expect(menu[0].rows.map(r => r.disabled)).toEqual([null, null, null])
    expect(menu[4].rows.map(r => r.pick.engine)).toEqual(['claude', 'codex', 'pixel'])
    expect(menu[2].rows.every(r => r.disabled === null)).toBe(true)
  })
  it('像素星空的对话：平台模型和自定义接口默认继续由它执行', () => {
    const menu = buildChannelMenu(input({ current: 'pixel' }))
    expect(menu[0].rows.map(r => r.pick.engine)).toEqual(['pixel', 'pixel', 'pixel'])
    expect(menu[4].rows.map(r => r.pick.engine)).toEqual(['pixel', 'pixel', 'pixel'])
  })
  it('自定义接口一行一个，选中的接口显示当前模型，其它显示第一个模型', () => {
    const menu = buildChannelMenu(
      input({ selection: { channel: 'custom', model: 'deepseek-reasoner', providerId: 'ds' } }),
    )
    expect(menu[4].rows.map(r => [r.target.model, r.selected])).toEqual([
      ['claude-sonnet-5-5', false],
      ['gpt-6.1', false],
      ['deepseek-reasoner', true],
    ])
  })
  it('记住的执行者', () => {
    const menu = buildChannelMenu(
      input({ remembered: { 'platform:claude-opus-5-5': 'pixel', 'custom:relay': 'pixel' } }),
    )
    expect(menu[0].rows[0].pick.engine).toBe('pixel')
    expect(menu[4].rows[0].pick.engine).toBe('pixel')
  })
  it('GPT 的旧 Claude Code 执行者记忆失效', () => {
    const platform = {
      ...input().platform,
      groups: [group('o', 'openai', ['gpt-6-astra', 'gpt-6.1-sol'], { supported_engines: ['claude', 'codex'] })],
    }
    const remembered = { 'platform:gpt-6.1-sol': 'claude' as const }
    const menu = buildChannelMenu(input({ platform, remembered }))
    expect(menu[0].rows.map(r => r.pick.engine)).toEqual(['codex', 'codex'])
    expect(menu[0].rows.map(r => r.pick.options)).toEqual([
      ['codex', 'pixel'],
      ['codex', 'pixel'],
    ])
    // 已开始的 Claude Code 对话选 GPT：Claude Code 跑不了，换成 Codex（界面会先确认）
    const started = buildChannelMenu(input({ platform, remembered, current: 'claude' }))
    expect(started[0].rows.map(r => r.pick.engine)).toEqual(['codex', 'codex'])
  })
  it('能跑的执行者都没装：灰掉', () => {
    const menu = buildChannelMenu(input({ engines: engines({ pixel: 'missing' }) }))
    expect(menu[4].rows.map(r => r.disabled)).toEqual([null, null, 'no-executor'])
  })
})

describe('本机存储', () => {
  it('执行者记忆：只留认得的引擎', () => {
    expect(parseExecutorMemory('{"platform:a":"pixel","b":"nope","c":3}')).toEqual({ 'platform:a': 'pixel' })
    expect(parseExecutorMemory('[1]')).toEqual({})
    expect(parseExecutorMemory('{')).toEqual({})
    expect(parseExecutorMemory(null)).toEqual({})
  })
  it('新任务默认：读不懂的都当「接着上次」', () => {
    expect(parseNewTask(null)).toEqual({ mode: 'last' })
    expect(parseNewTask('{"mode":"fixed"}')).toEqual({ mode: 'last' })
    expect(parseNewTask('{"mode":"fixed","choice":{"channel":"x","engine":"claude"}}')).toEqual({ mode: 'last' })
    expect(
      parseNewTask('{"mode":"fixed","choice":{"channel":"custom","model":"m","providerId":"p","engine":"pixel"}}'),
    ).toEqual({ mode: 'fixed', choice: { channel: 'custom', model: 'm', providerId: 'p', engine: 'pixel' } })
  })
})
