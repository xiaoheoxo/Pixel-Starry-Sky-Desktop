// 主模型调度的规则（docs/ui/subagent-model-dispatch.md §2、§5）
import { describe, expect, it } from 'vitest'
import { OUTSIDE_OFF, resolveDispatch, type DispatchCatalog, type DispatchMain } from './subagent-dispatch'
import { parseSubagentSettings, type SubagentDispatch, type SubagentTarget } from './types/subagents'

const GROUP = { kind: 'platform', groupId: '1' } as const
const main: DispatchMain = { site: GROUP, account: 'a@b.c', model: 'gpt-6-sol' }
const inGroup = (model: string): SubagentTarget => ({ kind: 'platform', groupId: '1', account: 'a@b.c', model })
const outside = (model: string): SubagentTarget => ({ kind: 'custom', providerId: 'p', model })
const PRICES: Record<string, { input: number; output: number }> = {
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-6-astra': { input: 10, output: 50 },
  // 输入便宜、输出贵：不算「不比它贵」
  mixed: { input: 1, output: 20 },
}
const catalog = (over: Partial<DispatchCatalog> = {}): DispatchCatalog => ({
  problem: () => null,
  siteModels: ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra', 'mixed', 'no-price'],
  price: m => PRICES[m] ?? null,
  ...over,
})
const dispatch = (over: Partial<SubagentDispatch> = {}): SubagentDispatch => ({
  rules: [],
  outsideGroup: false,
  unruled: 'cheaper',
  ...over,
})
const ruled = (over: Partial<SubagentDispatch> = {}): SubagentDispatch =>
  dispatch({
    rules: [
      {
        main: { site: GROUP, model: 'gpt-6-sol' },
        candidates: [
          { target: inGroup('gpt-6-astra'), note: '贵的' },
          { target: inGroup('gpt-6-luna'), note: '便宜的', isDefault: true },
          { target: outside('deepseek-chat'), note: '分组外' },
        ],
      },
    ],
    ...over,
  })
const models = (r: { options: Array<{ model: string }> }): string[] => r.options.map(o => o.model)

describe('resolveDispatch', () => {
  it('写了规则：只给规则里的，价格不限，默认用标的', () => {
    const r = resolveDispatch(ruled(), main, catalog())
    expect(models(r)).toEqual(['gpt-6-astra', 'gpt-6-luna'])
    expect(r.defaultModel).toBe('gpt-6-luna')
    expect(r.ruled).toBe(true)
  })

  it('分组外：开关没开不生效，开了才给，并标上分组外', () => {
    const off = resolveDispatch(ruled(), main, catalog())
    expect(off.off).toEqual([{ model: 'deepseek-chat', reason: OUTSIDE_OFF }])
    const on = resolveDispatch(ruled({ outsideGroup: true }), main, catalog())
    expect(on.off).toEqual([])
    expect(on.options.find(o => o.model === 'deepseek-chat')?.outside).toBe(true)
    expect(on.options.find(o => o.model === 'gpt-6-luna')?.outside).toBe(false)
  })

  it('同名模型换到另一个分组：规则按分组认，对不上就不算写了规则', () => {
    const other: DispatchMain = { ...main, site: { kind: 'platform', groupId: '2' } }
    const r = resolveDispatch(ruled(), other, catalog({ siteModels: ['gpt-6-sol'] }))
    expect(r.ruled).toBe(false)
    expect(r.options).toEqual([])
  })

  it('规则里的模型不能用了：进 off；默认的不能用时用第一个能用的；都不能用时用主模型自己', () => {
    const lunaGone = resolveDispatch(
      ruled(),
      main,
      catalog({ problem: t => (t.model === 'gpt-6-luna' ? 'modelGone' : null) }),
    )
    expect(lunaGone.defaultModel).toBe('gpt-6-astra')
    expect(lunaGone.off).toContainEqual({ model: 'gpt-6-luna', reason: 'modelGone' })
    const allGone = resolveDispatch(ruled(), main, catalog({ problem: () => 'signedOut' }))
    expect(allGone.options).toEqual([])
    expect(allGone.defaultModel).toBeNull()
  })

  it('没写规则：同分组不比它贵的，不含它自己；更贵、一边更贵、查不到价格的都不给；不填 model 用它自己', () => {
    const r = resolveDispatch(dispatch(), main, catalog())
    expect(models(r)).toEqual(['gpt-6.1-sol', 'gpt-6-luna'])
    expect(r.defaultModel).toBeNull()
  })

  it('没写规则、主模型查不到价格：只有它自己', () => {
    expect(resolveDispatch(dispatch(), { ...main, model: 'no-price' }, catalog()).options).toEqual([])
  })

  it('没写规则、选了用它自己：只有它自己', () => {
    expect(resolveDispatch(dispatch({ unruled: 'self' }), main, catalog()).options).toEqual([])
  })

  it('没写规则：不能用的不给（线路协议不支持等）', () => {
    const r = resolveDispatch(dispatch(), main, catalog({ problem: t => (t.model === 'gpt-6-luna' ? 'x' : null) }))
    expect(models(r)).toEqual(['gpt-6.1-sol'])
  })

  it('自定义接口也是一个分组：候选目标落在同一个接口上', () => {
    const r = resolveDispatch(
      dispatch(),
      { site: { kind: 'custom', providerId: 'p' }, account: null, model: 'gpt-6-sol' },
      catalog(),
    )
    expect(r.options[0]?.target).toEqual(outside('gpt-6.1-sol'))
  })

  it('用自己的登录（没有分组）：只有它自己', () => {
    expect(resolveDispatch(ruled(), { site: null, account: null, model: 'gpt-6-sol' }, catalog()).options).toEqual([])
  })
})

describe('parseSubagentSettings：dispatch', () => {
  const parse = (d: unknown) =>
    parseSubagentSettings({ types: [{ id: 'general', dispatch: d, target: inGroup('x') }] }).types[0]!

  it('没有 dispatch 时读出来和以前一样', () => {
    const t = parseSubagentSettings({ types: [{ id: 'general', target: inGroup('x') }] }).types[0]!
    expect(t.target).toEqual(inGroup('x'))
    expect('dispatch' in t).toBe(false)
  })

  it('和 target 互斥：认 dispatch', () => {
    const t = parse({ rules: [] })
    expect(t.target).toBeNull()
    expect(t.dispatch).toEqual({ rules: [], outsideGroup: false, unruled: 'cheaper' })
  })

  it('认不出的不抛错：坏规则、坏候选丢掉；模型名、默认不重复；说明压成一行', () => {
    const t = parse({
      unruled: 'nope',
      outsideGroup: 'yes',
      rules: [
        'bad',
        { main: { site: { kind: 'x' }, model: 'm' } },
        { main: { site: GROUP, model: 'bad model' } },
        {
          main: { site: GROUP, model: 'm' },
          candidates: [
            { target: inGroup('a'), note: '一行\n两行\u0007', isDefault: true },
            { target: outside('a'), note: '同名' },
            { target: inGroup('b'), isDefault: true },
            { target: { kind: 'platform', groupId: '1', model: 'no-account' } },
          ],
        },
        { main: { site: GROUP, model: 'm' }, candidates: [] },
      ],
    })
    expect(t.dispatch).toEqual({
      outsideGroup: false,
      unruled: 'cheaper',
      rules: [
        {
          main: { site: GROUP, model: 'm' },
          candidates: [
            { target: inGroup('a'), note: '一行 两行', isDefault: true },
            { target: inGroup('b'), note: '' },
          ],
        },
      ],
    })
  })

  it('上限：规则和候选都截断', () => {
    const t = parse({
      rules: Array.from({ length: 30 }, (_, i) => ({
        main: { site: GROUP, model: `m${i}` },
        candidates: Array.from({ length: 30 }, (_, j) => ({ target: inGroup(`c${j}`) })),
      })),
    })
    expect(t.dispatch?.rules).toHaveLength(20)
    expect(t.dispatch?.rules[0]?.candidates).toHaveLength(10)
  })
})
