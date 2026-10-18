import { describe, expect, it } from 'vitest'
import { parseSavedWindowState, sanitizeWindowBounds, type Rect } from './window-bounds'

const primary: Rect = { x: 0, y: 0, width: 1920, height: 1040 }
const left: Rect = { x: -1920, y: 0, width: 1920, height: 1040 }
const defaults = { width: 1568, height: 900 }
const min = { width: 1100, height: 700 }
const run = (saved: Rect | null, displays: Rect[] = [primary]) =>
  sanitizeWindowBounds(saved, displays, primary, defaults, min)

describe('sanitizeWindowBounds', () => {
  it('没存过：默认尺寸居中在主屏', () => {
    expect(run(null)).toEqual({ x: 176, y: 70, width: 1568, height: 900 })
  })

  it('完全在屏幕内：原样返回', () => {
    const r = { x: 100, y: 50, width: 1200, height: 800 }
    expect(run(r)).toEqual(r)
  })

  it('外接屏拔掉了：窗口在已不存在的屏幕上，回到主屏居中', () => {
    expect(run({ x: 2500, y: 100, width: 1200, height: 800 })).toEqual({ x: 176, y: 70, width: 1568, height: 900 })
  })

  it('屏幕变小：尺寸收进工作区，位置挪回来', () => {
    const small: Rect = { x: 0, y: 0, width: 1366, height: 728 }
    const r = sanitizeWindowBounds({ x: 500, y: 300, width: 1568, height: 900 }, [small], small, defaults, min)
    expect(r).toEqual({ x: 0, y: 0, width: 1366, height: 728 })
  })

  it('只露出一个角（小于 160×80）：当作丢了', () => {
    expect(run({ x: 1900, y: 1030, width: 1200, height: 800 })).toEqual({ x: 176, y: 70, width: 1568, height: 900 })
  })

  it('露出够多但有一部分在屏幕外：整体挪进工作区', () => {
    expect(run({ x: 1500, y: 600, width: 1200, height: 800 })).toEqual({ x: 720, y: 240, width: 1200, height: 800 })
  })

  it('主屏左边的显示器（负坐标）保持在那块屏上', () => {
    const r = { x: -1700, y: 40, width: 1200, height: 800 }
    expect(run(r, [primary, left])).toEqual(r)
  })

  it('跨两块屏：落在交集最大的那块', () => {
    const r = sanitizeWindowBounds({ x: -300, y: 0, width: 1200, height: 800 }, [primary, left], primary, defaults, min)
    // 主屏上露出 900 宽，左屏 300 宽 → 主屏
    expect(r).toEqual({ x: 0, y: 0, width: 1200, height: 800 })
  })

  it('比最小尺寸还小的存档会被抬到最小尺寸', () => {
    expect(run({ x: 10, y: 10, width: 300, height: 200 })).toEqual({ x: 10, y: 10, width: 1100, height: 700 })
  })

  it('工作区比最小尺寸还小：最小尺寸收到工作区大小', () => {
    const tiny: Rect = { x: 0, y: 0, width: 1024, height: 600 }
    const r = sanitizeWindowBounds({ x: 10, y: 10, width: 1500, height: 900 }, [tiny], tiny, defaults, min)
    expect(r).toEqual(tiny)
    expect(sanitizeWindowBounds(null, [tiny], tiny, defaults, min)).toEqual(tiny)
  })

  it('主屏工作区原点不在 (0,0)（任务栏在上 / 左）：默认居中和收进都按工作区算', () => {
    const p: Rect = { x: 0, y: 40, width: 1920, height: 1040 }
    expect(sanitizeWindowBounds(null, [p], p, defaults, min)).toEqual({ x: 176, y: 110, width: 1568, height: 900 })
    // 存档顶在屏幕最上沿（压在任务栏下）：挪到工作区内
    expect(sanitizeWindowBounds({ x: 100, y: 0, width: 1200, height: 800 }, [p], p, defaults, min)).toEqual({
      x: 100,
      y: 40,
      width: 1200,
      height: 800,
    })
  })

  it('没有任何显示器信息：回到默认', () => {
    expect(run({ x: 0, y: 0, width: 1200, height: 800 }, [])).toEqual({ x: 176, y: 70, width: 1568, height: 900 })
  })
})

describe('parseSavedWindowState', () => {
  it('正常值（小数取整）', () => {
    expect(parseSavedWindowState({ x: -10.4, y: 5, width: 1200.2, height: 800, maximized: true })).toEqual({
      x: -10,
      y: 5,
      width: 1200,
      height: 800,
      maximized: true,
    })
  })

  it.each([
    null,
    undefined,
    'x',
    3,
    {},
    { x: 1, y: 1, width: 0, height: 5 },
    { x: 'a', y: 1, width: 5, height: 5 },
    { x: NaN, y: 1, width: 5, height: 5 },
  ])('坏数据 %j 返回 null', v => {
    expect(parseSavedWindowState(v)).toBeNull()
  })

  it('maximized 不是 true 就是 false', () => {
    expect(parseSavedWindowState({ x: 0, y: 0, width: 5, height: 5, maximized: 'yes' })?.maximized).toBe(false)
  })
})
