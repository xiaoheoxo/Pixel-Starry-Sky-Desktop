// 明细表的列宽和隐藏条件（docs/ui/usage-learn.md §6）：窗口多窄、字号多大，模型列都不能被挤没
import { describe, expect, it } from 'vitest'
import { COLUMNS as RECORD_COLUMNS } from './RecordsTable'
import { COLUMNS as CALL_COLUMNS } from './RemoteCallsTable'
import type { UsageColumn } from './UsageTable'

const em = (width: string | undefined, narrow: boolean): number => {
  const small = /@max-\[([\d.]+)em\]:w-\[([\d.]+)em\]/.exec(width ?? '')
  if (narrow && small) return Number(small[2])
  return Number(/w-\[([\d.]+)em\]/.exec(width ?? '')?.[1] ?? 0)
}

/** 表格宽 w（em）时固定宽度的列一共占多少 */
function fixedWidth<T>(columns: Array<UsageColumn<T>>, w: number): number {
  const time = /@max-\[([\d.]+)em\]/.exec(columns[0].width ?? '')
  const narrow = !!time && w <= Number(time[1])
  return columns.filter(c => !c.hideBelow || w > c.hideBelow).reduce((sum, c) => sum + em(c.width, narrow), 0)
}

describe('明细表的列', () => {
  // 最窄：设置窗口最小宽度下表格 416px，字号最大时一个 em 是 15.55px
  const NARROWEST = 26.7

  it.each([
    ['本机记录', RECORD_COLUMNS],
    ['账号调用', CALL_COLUMNS],
  ] as const)('%s：模型列至少留 5em', (_, columns) => {
    for (let w = NARROWEST; w <= 90; w += 0.1)
      expect(w - fixedWidth(columns as Array<UsageColumn<never>>, w)).toBeGreaterThan(5)
  })
})
