import { afterEach, describe, expect, it } from 'vitest'
import {
  costHint,
  costSubtitle,
  dimLabel,
  formatCardCost,
  formatCost,
  formatRecordCost,
  formatTotalCost,
} from './format'
import type { UsageRecord } from './types'
import { setCurrentLocale } from '../../i18n/core'
import { replyStatParts } from '../session/turnStatsData'
afterEach(() => setCurrentLocale('zh-CN'))
describe('billing labels', () => {
  it('shows precise actual subscription amounts and translates pending states', () => {
    expect(formatCost(0.0034, 'platform', 'subscription')).toBe('订阅 $0.0034')
    expect(formatCost(0, 'platform')).toBe('$0')
    expect(formatCost(90, 'pending')).toBe('费用结算中…')
    expect(formatCost(90, 'unavailable')).toBe('—')
    setCurrentLocale('en-US')
    expect(formatCost(null, 'pending')).toBe('Settling cost…')
    expect(formatCost(0.0034, 'platform', 'subscription')).toBe('Subscription $0.0034')
  })
  it('distinguishes estimates, authoritative totals and incomplete totals', () => {
    expect(formatCost(0.17)).toBe('≈ $0.17')
    expect(formatTotalCost({ costUsd: 0.0034, costKnown: 1, costActual: 1, records: 1 })).toBe('$0.0034')
    expect(formatTotalCost({ costUsd: 0.0034, costKnown: 1, costActual: 1, records: 2 })).toBe('≥ $0.0034')
    const result = replyStatParts({
      durationMs: 1,
      models: { model: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: null, costSource: 'unavailable' } },
    })
    expect(result.parts.find(p => p.key === 'cost')).toMatchObject({ text: '—' })
  })
  it('没有费用的记录按原因显示（GitHub #22）', () => {
    const r = (over: Partial<UsageRecord>): UsageRecord => ({
      v: 1,
      id: 'a',
      sessionId: 's',
      turnId: 't',
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
      sessionTitle: '',
      project: null,
      engine: 'claude',
      model: 'm',
      route: 'cli',
      input: 1,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1,
      costUsd: null,
      outcome: 'completed',
      ...over,
    })
    expect(formatRecordCost(r({ route: 'pixelsky', costSource: 'pending' }))).toBe('费用结算中…')
    // 补录对过没对上的 pending 行不再显示结算中
    expect(formatRecordCost(r({ route: 'pixelsky', costSource: 'pending', costMatch: 'none' }))).toBe('—')
    expect(formatRecordCost(r({ route: 'api-key', costSource: 'estimate' }))).toBe('未定价')
    expect(formatRecordCost(r({ costUsd: 0.17 }))).toBe('≈ $0.17')
    expect(dimLabel('cost', 'no-price')).toBe('对不上官方价格')
    expect(dimLabel('cost', 'missing')).toBe('没有费用')
    expect(dimLabel('cost', 'other')).toBe('other')
    expect(costHint('no-price')).toContain('计价参照')
    expect(costHint('other')).toBe('')
    setCurrentLocale('en-US')
    expect(dimLabel('cost', 'platform')).toBe('Not matched in platform bill')
  })
  it('费用卡副标题：缺失 / 实扣 / 官方价格估算 / 引擎估算', () => {
    expect(costSubtitle({ costKnown: 1, records: 3 })).toBe('missing')
    expect(costSubtitle({ costKnown: 2, records: 2, costActual: 2 })).toBe('actual')
    const routes = (keys: string[]) => keys.map(key => ({ key, costKnown: 1 }))
    expect(costSubtitle({ costKnown: 2, records: 2 }, routes(['api-key']))).toBe('official')
    expect(costSubtitle({ costKnown: 2, records: 2 }, [...routes(['api-key']), { key: 'cli', costKnown: 0 }])).toBe(
      'official',
    )
    expect(costSubtitle({ costKnown: 2, records: 2 }, routes(['api-key', 'cli']))).toBe('engine')
    expect(costSubtitle({ costKnown: 2, records: 2 })).toBe('engine')
    expect(costSubtitle({ costKnown: 0, records: 0 }, [])).toBe('engine')
  })
  it('费用卡大数字：满 1 美元两位小数，不到 1 美元照合计精度（D114 §3）', () => {
    expect(formatCardCost({ costUsd: 10.582741, costKnown: 3, records: 4 })).toBe('≥ $10.58')
    expect(formatCardCost({ costUsd: 10.582741, costKnown: 4, records: 4, costActual: 4 })).toBe('$10.58')
    expect(formatCardCost({ costUsd: 2.5, costKnown: 4, records: 4 })).toBe('≈ $2.50')
    expect(formatCardCost({ costUsd: 0.003412, costKnown: 2, records: 2, costActual: 2 })).toBe('$0.003412')
    expect(formatCardCost({ costUsd: 0, costKnown: 0, records: 3 })).toBe('—')
    expect(formatTotalCost({ costUsd: 10.582741, costKnown: 3, records: 4 })).toBe('≥ $10.582741')
  })
})
