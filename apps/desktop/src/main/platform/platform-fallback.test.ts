// 订阅额度都用完、自动改用平台时挑线路（docs/ui/engine-accounts.md §5.2）：同名模型倍率最低、同系列、余额计费的线路
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '', on: () => undefined } }))
vi.mock('../app/data-dir', () => ({ dataRoot: () => '', localRoot: () => '' }))

const platform = vi.hoisted(() => ({
  email: 'me@pixel.test' as string | null,
  balance: 10 as number | null,
  groups: [] as unknown[],
  /** 目录里没列模型的线路按线路读到的模型 */
  models: {} as Record<string, string[]>,
}))
vi.mock('../account/account', () => ({
  signedInEmail: () => platform.email,
  platformBalance: async () => platform.balance,
  onAccountChange: () => () => undefined,
  platformFetch: async (path: string) => {
    if (path === '/v1/platform/groups') return Response.json({ data: platform.groups })
    const m = /^\/v1\/platform\/groups\/(\d+)\/models$/.exec(path)
    return Response.json({ data: m ? (platform.models[m[1]] ?? []) : [] })
  },
}))

const { modelFamily, platformFallbackRoute } = await import('./platform')

const line = (id: string, name: string, rate: number, models: string[], extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: '',
  platform: 'openai',
  rate_multiplier: rate,
  billing_source: 'balance',
  models,
  ...extra,
})

beforeEach(() => {
  platform.email = 'me@pixel.test'
  platform.balance = 10
  platform.models = {}
})

describe('改用平台挑线路', () => {
  it('有同名模型的线路里倍率最低的', async () => {
    platform.groups = [
      line('1', '标准', 1, ['gpt-5.5', 'gpt-5.4']),
      line('2', '便宜', 0.5, ['gpt-5.4']),
      line('3', '次便宜', 0.8, ['gpt-5.5']),
    ]
    expect(await platformFallbackRoute('codex', 'gpt-5.5')).toEqual({
      groupId: '3',
      group: '次便宜',
      account: 'me@pixel.test',
      model: 'gpt-5.5',
    })
    expect(await platformFallbackRoute('codex', 'gpt-5.4')).toMatchObject({ groupId: '2', model: 'gpt-5.4' })
    // 没有模型（引擎默认）：倍率最低线路的第一个
    expect(await platformFallbackRoute('codex', null)).toMatchObject({ groupId: '2', model: 'gpt-5.4' })
  })

  it('没有同名的：同系列里倍率最低的；同系列也没有：倍率最低线路的第一个模型', async () => {
    platform.groups = [
      line('11', 'Sonnet', 1, ['claude-sonnet-4-6'], { platform: 'anthropic' }),
      line('12', 'Opus', 0.6, ['claude-opus-4-7', 'claude-sonnet-4-5'], { platform: 'anthropic' }),
    ]
    expect(await platformFallbackRoute('claude', 'claude-opus-4-5-20251101')).toMatchObject({
      groupId: '12',
      model: 'claude-opus-4-7',
    })
    expect(await platformFallbackRoute('claude', 'opus')).toMatchObject({ groupId: '12', model: 'claude-opus-4-7' })
    expect(await platformFallbackRoute('claude', 'claude-haiku-4-5')).toMatchObject({
      groupId: '12',
      model: 'claude-opus-4-7',
    })
  })

  it('只看这个引擎能用的线路和模型', async () => {
    platform.groups = [
      line('21', 'Claude 线路', 0.1, ['claude-opus-4-7'], { platform: 'anthropic' }),
      line('22', '混合', 0.5, ['claude-sonnet-4-6', 'gpt-5.4']),
      line('23', 'GPT', 1, ['gpt-5.5']),
    ]
    expect(await platformFallbackRoute('codex', 'claude-opus-4-7')).toMatchObject({ groupId: '22', model: 'gpt-5.4' })
    platform.groups = [line('24', 'Claude 线路', 0.1, ['claude-opus-4-7'], { platform: 'anthropic' })]
    expect(await platformFallbackRoute('codex', 'gpt-5.5')).toEqual({ error: '平台上没有这个引擎能用的线路' })
  })

  it('余额 ≤ 0：跳过余额计费的线路；都是余额计费的就说余额不足', async () => {
    platform.balance = 0
    platform.groups = [
      line('31', '余额', 0.3, ['gpt-5.5']),
      line('32', '订阅', 1, ['gpt-5.5'], { billing_source: 'plan_only' }),
    ]
    expect(await platformFallbackRoute('codex', 'gpt-5.5')).toMatchObject({ groupId: '32' })
    platform.groups = [line('33', '余额', 0.3, ['gpt-5.5'])]
    expect(await platformFallbackRoute('codex', 'gpt-5.5')).toEqual({ error: '平台余额不足，请先充值' })
    // 读不到余额不当作不足
    platform.balance = null
    expect(await platformFallbackRoute('codex', 'gpt-5.5')).toMatchObject({ groupId: '33' })
  })

  it('目录里没列模型的线路按线路再读一次；都读不到就说没有模型', async () => {
    platform.groups = [line('41', '空目录', 0.2, []), line('42', '标准', 1, ['gpt-5.4'])]
    platform.models = { '41': ['gpt-5.5'] }
    expect(await platformFallbackRoute('codex', 'gpt-5.5')).toMatchObject({ groupId: '41', model: 'gpt-5.5' })
    platform.groups = [line('43', '空目录', 0.2, [])]
    expect(await platformFallbackRoute('codex', 'gpt-5.5')).toEqual({ error: '平台线路上没有这个引擎能用的模型' })
  })

  it('没登录平台：不改', async () => {
    platform.email = null
    platform.groups = [line('51', '标准', 1, ['gpt-5.5'])]
    expect(await platformFallbackRoute('codex', 'gpt-5.5')).toEqual({ error: '没有登录像素星空账号' })
  })
})

describe('modelFamily', () => {
  it('Claude 按 opus / sonnet / haiku，其余去掉厂商前缀、[1m]、日期和版本号', () => {
    expect(modelFamily('claude-3-5-sonnet-20241022')).toBe('sonnet')
    expect(modelFamily('claude-opus-4-7[1m]')).toBe('opus')
    expect(modelFamily('anthropic.claude-haiku-4-5')).toBe('haiku')
    expect(modelFamily('gpt-5.5-codex')).toBe('gpt-codex')
    expect(modelFamily('openai/gpt-5.4-mini')).toBe('gpt-mini')
    expect(modelFamily('gpt-5.5')).toBe(modelFamily('gpt-5.4'))
  })
})
