import { describe, expect, it } from 'vitest'
import { ZOOM_SITES_MAX, isZoomMove, nextZoom, rememberZoom, zoomSiteOf } from './browser-tools'

describe('缩放档位', () => {
  it('按档位放大、缩小、还原', () => {
    expect(nextZoom(1, 'in')).toBe(1.1)
    expect(nextZoom(1, 'out')).toBe(0.9)
    expect(nextZoom(1.5, 'reset')).toBe(1)
  })
  it('到头了停在最大 / 最小', () => {
    expect(nextZoom(5, 'in')).toBe(5)
    expect(nextZoom(0.25, 'out')).toBe(0.25)
  })
  it('不在档位上（别处改过）时就近往上 / 往下', () => {
    expect(nextZoom(1.05, 'in')).toBe(1.1)
    expect(nextZoom(1.05, 'out')).toBe(1)
    // 浮点误差不算不在档位上
    expect(nextZoom(1.1000001, 'in')).toBe(1.25)
  })
  it('只认三种动作', () => {
    expect(isZoomMove('in')).toBe(true)
    expect(isZoomMove('bigger')).toBe(false)
    expect(isZoomMove(undefined)).toBe(false)
  })
})

describe('按网站记住缩放', () => {
  it('网站是主机名（不分端口），项目里的本地文件算一个，别的不记', () => {
    expect(zoomSiteOf('http://localhost:5173/a')).toBe('localhost')
    expect(zoomSiteOf('https://example.com:8443/')).toBe('example.com')
    // 本地文件以前没有主机名，缩放生效但界面显示 100%、记不住
    expect(zoomSiteOf('file:///D:/proj/index.html')).toBe('file:')
    expect(zoomSiteOf('about:blank')).toBeNull()
    expect(zoomSiteOf('not a url')).toBeNull()
  })
  it('100% 不记，改回 100% 时删掉', () => {
    expect(rememberZoom(undefined, 'a.com', 1)).toEqual({})
    expect(rememberZoom({ 'a.com': 1.25 }, 'a.com', 1)).toEqual({})
    expect(rememberZoom({ 'a.com': 1.25 }, 'b.com', 0.9)).toEqual({ 'a.com': 1.25, 'b.com': 0.9 })
  })
  it('超过上限丢最早改的', () => {
    let map: Record<string, number> = {}
    for (let i = 0; i <= ZOOM_SITES_MAX; i++) map = rememberZoom(map, `s${i}`, 1.25)
    expect(Object.keys(map)).toHaveLength(ZOOM_SITES_MAX)
    expect(map.s0).toBeUndefined()
    // 再改一次 s1：挪到最新，下次丢的是 s2
    map = rememberZoom(map, 's1', 1.5)
    map = rememberZoom(map, 'new', 1.5)
    expect(map.s1).toBe(1.5)
    expect(map.s2).toBeUndefined()
  })
})
