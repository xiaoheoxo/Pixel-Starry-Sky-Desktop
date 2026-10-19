import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STICK_PX } from './scrollFollow'
import { GLIDE_SAFETY_MS, approach, glideEnd, glideStart, glideToEnd, type GlideEnd } from './glide'

describe('纯计算', () => {
  it('glideEnd：能滚到的最底位置，内容比视口矮时为 0', () => {
    expect(glideEnd({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 })).toBe(600)
    expect(glideEnd({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(0)
  })

  it('glideStart：离底超过 1.5 屏先跳到离底 1.5 屏处，近的不动', () => {
    expect(glideStart({ scrollTop: 0, scrollHeight: 10400, clientHeight: 400 })).toBe(10000 - 600)
    expect(glideStart({ scrollTop: 9500, scrollHeight: 10400, clientHeight: 400 })).toBe(9500)
    // 刚好 1.5 屏不跳
    expect(glideStart({ scrollTop: 9400, scrollHeight: 10400, clientHeight: 400 })).toBe(9400)
  })

  it('approach：单调靠近终点，不越过，最后不到半像素吸附', () => {
    let cur = 0
    let last = 0
    for (let i = 0; i < 200 && cur !== 100; i++) {
      cur = approach(cur, 100, 16)
      expect(cur).toBeGreaterThanOrEqual(last)
      expect(cur).toBeLessThanOrEqual(100)
      last = cur
    }
    expect(cur).toBe(100)
    expect(approach(50, 100, 0)).toBe(50)
    expect(approach(99.8, 100, 0)).toBe(100)
  })
})

/** 假的滚动容器：scrollTop 夹在 [0, scrollHeight - clientHeight]，事件监听可手动触发 */
function fakeBox(scrollHeight: number, clientHeight: number, scrollTop = 0) {
  const handlers = new Map<string, Set<() => void>>()
  let top = scrollTop
  const el = {
    scrollHeight,
    clientHeight,
    isConnected: true,
    get scrollTop() {
      return top
    },
    set scrollTop(v: number) {
      top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight))
    },
    addEventListener: (name: string, fn: () => void) => {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name)!.add(fn)
    },
    removeEventListener: (name: string, fn: () => void) => handlers.get(name)?.delete(fn),
    fire: (name: string) => [...(handlers.get(name) ?? [])].forEach(fn => fn()),
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  }
  return el
}

/** 假的 rAF：手动一帧一帧推进，每帧 16ms */
function fakeRaf() {
  let queue = new Map<number, (now: number) => void>()
  let id = 0
  let now = 1000
  return {
    raf: (cb: (now: number) => void) => {
      queue.set(++id, cb)
      return id
    },
    caf: (i: number) => void queue.delete(i),
    pending: () => queue.size,
    frame() {
      now += 16
      const cur = queue
      queue = new Map()
      cur.forEach(cb => cb(now))
      vi.advanceTimersByTime(16)
    },
  }
}

describe('glideToEnd', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const run = (el: ReturnType<typeof fakeBox>, motion = true) => {
    const f = fakeRaf()
    const ends: GlideEnd[] = []
    const cancel = glideToEnd(el as unknown as HTMLElement, {
      motion,
      onEnd: r => ends.push(r),
      raf: f.raf,
      caf: f.caf,
    })
    return { f, ends, cancel }
  }

  it('动画关了：同步跳到底并结束，不排帧', () => {
    const el = fakeBox(5000, 500)
    const { f, ends } = run(el, false)
    expect(el.scrollTop).toBe(4500)
    expect(ends).toEqual(['done'])
    expect(f.pending()).toBe(0)
    expect(el.listeners()).toBe(0)
  })

  it('离得远：先跳到离底 1.5 屏处，再逐帧靠近直到到底并结束', () => {
    const el = fakeBox(20000, 500)
    const { f, ends } = run(el)
    expect(el.scrollTop).toBe(19500 - 750)
    let prev = el.scrollTop
    let frames = 0
    while (ends.length === 0 && frames < 200) {
      f.frame()
      frames++
      expect(el.scrollTop).toBeGreaterThanOrEqual(prev)
      prev = el.scrollTop
    }
    expect(ends).toEqual(['done'])
    expect(el.scrollTop).toBe(19500)
    expect(frames).toBeGreaterThan(5) // 是缓动不是一步到位
    expect(f.pending()).toBe(0)
    expect(el.listeners()).toBe(0)
  })

  it('每帧按当前高度重算终点：滑动期间内容变长也追到新的底', () => {
    const el = fakeBox(3000, 500)
    const { f, ends } = run(el)
    f.frame()
    f.frame()
    el.scrollHeight = 4000
    for (let i = 0; i < 200 && ends.length === 0; i++) f.frame()
    expect(ends).toEqual(['done'])
    expect(el.scrollTop).toBe(3500)
  })

  it.each(['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown'])(
    '用户 %s 打断：停在原地，回调 cancel，不再排帧',
    name => {
      const el = fakeBox(10000, 500)
      const { f, ends } = run(el)
      f.frame()
      f.frame()
      const at = el.scrollTop
      el.fire(name)
      expect(ends).toEqual(['cancel'])
      expect(f.pending()).toBe(0)
      f.frame()
      expect(el.scrollTop).toBe(at)
      expect(el.listeners()).toBe(0)
    },
  )

  it('手动取消只回调一次，结束后再取消无效', () => {
    const el = fakeBox(10000, 500)
    const { f, ends, cancel } = run(el)
    f.frame()
    cancel()
    cancel()
    expect(ends).toEqual(['cancel'])
    const done = run(fakeBox(100, 50), false)
    done.cancel()
    expect(done.ends).toEqual(['done'])
  })

  it('别人在滑动期间往下改了 scrollTop（锚定修正）：变化被带上，不被拽回', () => {
    const el = fakeBox(20000, 500)
    const { f, ends } = run(el)
    f.frame()
    const before = el.scrollTop
    el.scrollTop = before + 200
    f.frame()
    expect(el.scrollTop).toBeGreaterThan(before + 200)
    for (let i = 0; i < 300 && ends.length === 0; i++) f.frame()
    expect(ends).toEqual(['done'])
    expect(el.scrollTop).toBe(19500)
  })

  it('元素外的操作把位置往上挪（拖滚动条、点轮次条、搜索跳转）：当作用户滚动，cancel 且不再写入', () => {
    const el = fakeBox(20000, 500)
    const { f, ends } = run(el)
    f.frame()
    const moved = el.scrollTop - 300
    el.scrollTop = moved
    f.frame()
    expect(ends).toEqual(['cancel'])
    expect(el.scrollTop).toBe(moved)
    expect(f.pending()).toBe(0)
    f.frame()
    expect(el.scrollTop).toBe(moved)
    expect(el.listeners()).toBe(0)
  })

  it('往上挪不到 1px（取整抖动）不算打断', () => {
    const el = fakeBox(20000, 500)
    const { f, ends } = run(el)
    f.frame()
    el.scrollTop = el.scrollTop - 1
    f.frame()
    expect(ends).toEqual([])
  })

  it('内容变矮被浏览器夹到底部（位置往上变了但就在底）：不算用户上滚，继续并正常结束', () => {
    const el = fakeBox(6000, 500)
    const { f, ends } = run(el)
    f.frame()
    el.scrollHeight = 3000
    el.scrollTop = 2500
    for (let i = 0; i < 100 && ends.length === 0; i++) f.frame()
    expect(ends).toEqual(['done'])
    expect(el.scrollTop).toBe(2500)
  })

  it('内容一直在慢慢变长：缓动落后一点也能在保险超时之前追上贴底范围并 done', () => {
    const el = fakeBox(20000, 500)
    const { f, ends } = run(el)
    let frames = 0
    while (ends.length === 0 && frames < 200) {
      el.scrollHeight += 10 // 每帧长 10px，缓动稳态落后约 54px，永远到不了 0.5px
      f.frame()
      frames++
    }
    expect(ends).toEqual(['done'])
    expect(frames * 16).toBeLessThan(GLIDE_SAFETY_MS)
    // 收尾时已经贴在底部，交给贴底接手
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThan(STICK_PX)
    expect(f.pending()).toBe(0)
  })

  it('内容长得比缓动快（落后超过贴底范围）：继续追，不提前收尾；停止增长后到底 done', () => {
    const el = fakeBox(20000, 500)
    const { f, ends } = run(el)
    for (let i = 0; i < 40; i++) {
      el.scrollHeight += 60
      f.frame()
    }
    expect(ends).toEqual([])
    for (let i = 0; i < 300 && ends.length === 0; i++) f.frame()
    expect(ends).toEqual(['done'])
    expect(el.scrollTop).toBe(el.scrollHeight - el.clientHeight)
  })

  it('元素脱离文档：按 cancel 结束', () => {
    const el = fakeBox(10000, 500)
    const { f, ends } = run(el)
    el.isConnected = false
    f.frame()
    expect(ends).toEqual(['cancel'])
  })

  it('rAF 一直不来（后台标签）：保险超时直接到底并结束，不会一直 jumping', () => {
    const el = fakeBox(10000, 500)
    const f = fakeRaf()
    const ends: GlideEnd[] = []
    glideToEnd(el as unknown as HTMLElement, { motion: true, onEnd: r => ends.push(r), raf: f.raf, caf: f.caf })
    vi.advanceTimersByTime(GLIDE_SAFETY_MS - 1)
    expect(ends).toEqual([])
    vi.advanceTimersByTime(1)
    expect(ends).toEqual(['done'])
    expect(el.scrollTop).toBe(9500)
    expect(f.pending()).toBe(0)
  })

  it('正常结束后保险定时器被清掉，不会再回调', () => {
    const el = fakeBox(1000, 500)
    const { f, ends } = run(el)
    for (let i = 0; i < 300 && ends.length === 0; i++) f.frame()
    vi.advanceTimersByTime(GLIDE_SAFETY_MS * 2)
    expect(ends).toEqual(['done'])
  })
})
