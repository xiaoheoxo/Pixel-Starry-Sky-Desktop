import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} }
})
vi.mock('@/features/engine/store', () => ({ bridge: undefined, useEngineState: () => '' }))
vi.mock('@/features/machines/store', () => ({ machineOf: () => 'local', useMachines: () => ({ currentId: 'local' }) }))
vi.mock('@/data', () => ({ isDemo: false }))
import { I18nProvider } from '@/i18n/I18nProvider'
import { AccountUsageView } from './AccountUsagePanel'
import type { EngineAccountUsage } from '@pixelsky/protocol'
import { usageResetCountdown, usageWindowLabel } from './accountUsageData'

const now = Date.parse('2026-10-19T08:12:00Z')
const render = (usage: EngineAccountUsage | null, loading = false): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <AccountUsageView engine="claude" usage={usage} loading={loading} now={now} onRefresh={() => {}} />
    </I18nProvider>,
  )
const weekly: EngineAccountUsage = {
  status: 'ready',
  observedAt: now,
  windows: [{ id: 'week', kind: 'weekly', usedPercent: 72, resetsAt: now + 74 * 3600000 }],
}
describe('账号额度面板', () => {
  it('只有周额时无 5h 行、无 5h 重置时间或剩余值', () => {
    const html = render(weekly)
    expect(html).toContain('每周额度')
    expect(html).toContain('72%')
    expect(html).toContain('剩余 28%')
    expect(html).toContain('3 天 2 小时后重置')
    expect(html).not.toContain('5 小时额度')
    expect(html.match(/data-account-usage-window=/g)).toHaveLength(1)
  })
  it('读取中、失败、旧版不支持、无订阅和成功空列表有不同提示', () => {
    expect(render(null, true)).toContain('正在读取账号额度')
    for (const [status, text] of [
      ['error', '暂时无法获取'],
      ['unsupported', '不支持查询'],
      ['unavailable', '未提供账号额度数据'],
    ] as const) {
      const html = render({ status, observedAt: now, windows: [] })
      expect(html).toContain(text)
      expect(html).not.toContain('role="progressbar"')
    }
    expect(render({ status: 'ready', observedAt: now, windows: [] })).toContain('未返回额度限制项')
  })
  it('未知利用率不用 0% 冒充；进度条夹紧但保留真实超额值', () => {
    const unknown = render({ ...weekly, windows: [{ ...weekly.windows[0], usedPercent: null, resetsAt: null }] })
    expect(unknown).toContain('重置时间未提供')
    expect(unknown).not.toContain('aria-valuenow')
    expect(unknown).not.toContain('剩余')
    const over = render({ ...weekly, windows: [{ ...weekly.windows[0], usedPercent: 125 }] })
    expect(over).toContain('125%')
    expect(over).toContain('aria-valuenow="100"')
    expect(over).toContain('width:100%')
    expect(over).toContain('已用尽')
  })
  it('过期的重置时间等待引擎更新，不自行把使用率清零；周期名称按实际时长', () => {
    expect(usageResetCountdown(now - 1, now)).toBe('等待额度更新')
    expect(usageResetCountdown(now + 61000, now)).toBe('2 分钟后重置')
    expect(usageWindowLabel({ id: 'x', kind: 'other', windowMinutes: 60, usedPercent: 1, resetsAt: null })).toBe(
      '1 小时额度',
    )
  })
})
