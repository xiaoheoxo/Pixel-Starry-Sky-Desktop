// 明细表的分组标题（docs/ui/usage.md §9.4）：隐藏列后组名那一行跨的列数要跟着变，不然标题对不上下面的列
import { describe, expect, it } from 'vitest'
import { COLUMNS as RECORD_COLUMNS } from './RecordsTable'
import { COLUMNS as CALL_COLUMNS } from './RemoteCallsTable'
import { groupCells, splitTime, type UsageColumn } from './UsageTable'

const shown = (c: { from?: number; to?: number }, w: number): boolean =>
  (c.from === undefined || w >= c.from) && (c.to === undefined || w < c.to)

describe('组名那一行', () => {
  it.each([
    ['本机记录', RECORD_COLUMNS],
    ['账号调用', CALL_COLUMNS],
  ] as const)('%s：任意宽度下跨的列数等于显示的列数', (_, raw) => {
    const columns = raw as Array<UsageColumn<never>>
    const cells = groupCells(columns)
    for (let w = 20; w <= 100; w += 0.5) {
      const visible = columns.filter(c => !c.hideBelow || w >= c.hideBelow).length
      const span = cells.filter(c => shown(c, w)).reduce((sum, c) => sum + c.colSpan, 0)
      expect(span, `${w}em`).toBe(visible)
    }
  })

  it('一组的列全部隐藏时不留空格子；相邻不同组分开', () => {
    const col = (key: string, group?: string, hideBelow?: UsageColumn<never>['hideBelow']): UsageColumn<never> => ({
      key,
      label: key,
      group,
      hideBelow,
      render: () => null,
    })
    const cells = groupCells([col('a'), col('b', 'X', 50), col('c', 'X', 64), col('d', '')])
    expect(cells.map(c => [c.label, c.colSpan, c.from, c.to])).toEqual([
      ['', 1, undefined, undefined],
      ['X', 1, 50, 64],
      ['X', 2, 64, undefined],
      ['', 1, undefined, undefined],
    ])
    expect(cells.map(c => c.gap)).toEqual([false, true, true, true])
  })
})

describe('时间单元格', () => {
  it('日期和时刻分开，英文的上下午不丢', () => {
    expect(splitTime('10-02 18:24')).toEqual(['10-02 ', '18:24'])
    expect(splitTime('Nov 5, 7:30 PM')).toEqual(['Nov 5, ', '7:30 PM'])
    expect(splitTime('5:33 PM')).toEqual(['', '5:33 PM'])
    expect(splitTime('18:24')).toEqual(['', '18:24'])
    expect(splitTime('昨天')).toEqual(['', '昨天'])
  })
})
