import { describe, expect, it } from 'vitest'
import { appHeight, startViewport, type ViewportHost, type ViewportLike } from './viewport'

function fake(initial: { height: number; scale?: number; offsetTop?: number; scrollY?: number }) {
  const listeners = new Map<string, Set<() => void>>()
  const vv: ViewportLike = {
    height: initial.height,
    scale: initial.scale ?? 1,
    offsetTop: initial.offsetTop ?? 0,
    addEventListener: (type, l) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(l),
    removeEventListener: (type, l) => void listeners.get(type)?.delete(l),
  }
  const vars = new Map<string, string>()
  const scrolls: [number, number][] = []
  const win: ViewportHost = {
    visualViewport: vv,
    scrollY: initial.scrollY ?? 0,
    scrollTo: (x, y) => void scrolls.push([x, y]),
    document: {
      documentElement: {
        style: {
          setProperty: (k: string, v: string | null) => void vars.set(k, String(v)),
          removeProperty: (k: string) => {
            const old = vars.get(k) ?? ''
            vars.delete(k)
            return old
          },
        },
      },
    },
  }
  const fire = (type: 'resize' | 'scroll') => listeners.get(type)?.forEach(l => l())
  return { vv, win, vars, scrolls, fire, listeners }
}

describe('appHeight', () => {
  it('uses the visual viewport height, rounded', () => {
    expect(appHeight({ height: 512.4, scale: 1 })).toBe(512)
  })
  it('leaves things alone without a viewport or while pinch-zoomed', () => {
    expect(appHeight(null)).toBeNull()
    expect(appHeight({ height: 0, scale: 1 })).toBeNull()
    expect(appHeight({ height: 400, scale: 2 })).toBeNull()
  })
})

describe('startViewport', () => {
  it('writes --app-height at start and follows the keyboard', () => {
    const f = fake({ height: 800 })
    startViewport(f.win)
    expect(f.vars.get('--app-height')).toBe('800px')
    f.vv.height = 480 // 键盘弹出
    f.fire('resize')
    expect(f.vars.get('--app-height')).toBe('480px')
    f.vv.height = 800
    f.fire('resize')
    expect(f.vars.get('--app-height')).toBe('800px')
  })

  it('scrolls the page back when iOS pushed it up', () => {
    const f = fake({ height: 480, offsetTop: 120 })
    startViewport(f.win)
    expect(f.scrolls).toEqual([[0, 0]])
    f.vv.offsetTop = 0
    f.fire('scroll')
    expect(f.scrolls).toHaveLength(1)
  })

  it('does not touch the height while zoomed in', () => {
    const f = fake({ height: 800 })
    startViewport(f.win)
    f.vv.height = 300
    f.vv.scale = 2.5
    f.fire('resize')
    expect(f.vars.get('--app-height')).toBe('800px')
  })

  it('does nothing without visualViewport, and stop() removes the variable and listeners', () => {
    const none = fake({ height: 800 })
    none.win.visualViewport = null
    startViewport(none.win)()
    expect(none.vars.size).toBe(0)

    const f = fake({ height: 800 })
    const stop = startViewport(f.win)
    stop()
    expect(f.vars.has('--app-height')).toBe(false)
    expect([...f.listeners.values()].every(s => s.size === 0)).toBe(true)
  })
})
