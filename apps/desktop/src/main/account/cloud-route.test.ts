import { describe, expect, it } from 'vitest'
import { CLOUD_ROUTES, SWITCH_MARGIN_MS, parseSavedRoute, pickRoute, probeRoute } from './cloud-route'

const r = (id: 'cdn' | 'direct', ms: number | null) => ({ id, ms })

describe('云端线路择优（docs/network-direct.md §3）', () => {
  it('第一次：取通的里最快的；都不通保持 null', () => {
    expect(pickRoute(null, [r('cdn', 1100), r('direct', 800)])).toBe('direct')
    expect(pickRoute(null, [r('cdn', null), r('direct', null)])).toBeNull()
  })

  it('快不过阈值不换，够快才换；当前这条不通就换到通的', () => {
    expect(pickRoute('cdn', [r('cdn', 850), r('direct', 800)])).toBe('cdn')
    expect(pickRoute('cdn', [r('cdn', 800 + SWITCH_MARGIN_MS), r('direct', 800)])).toBe('direct')
    expect(pickRoute('direct', [r('cdn', 900), r('direct', null)])).toBe('cdn')
    expect(pickRoute('direct', [r('cdn', null), r('direct', null)])).toBe('direct')
  })

  it('测速：2xx 且 ok 为 true 才算通；非 2xx、不是云端的回答、连不上都作废', async () => {
    let t = 0
    const now = () => (t += 100)
    const fetchOk = (async () => new Response(JSON.stringify({ ok: true, version: '0.3.36' }))) as typeof fetch
    const fetch500 = (async () => new Response('x', { status: 500 })) as typeof fetch
    const fetchHtml = (async () => new Response('<html>')) as typeof fetch
    const fetchDown = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    expect(await probeRoute(CLOUD_ROUTES[0], fetchOk, 1000, now)).toEqual({ id: 'cdn', ms: 100 })
    expect((await probeRoute(CLOUD_ROUTES[1], fetch500, 1000, now)).ms).toBeNull()
    expect((await probeRoute(CLOUD_ROUTES[1], fetchHtml, 1000, now)).ms).toBeNull()
    expect((await probeRoute(CLOUD_ROUTES[1], fetchDown, 1000, now)).ms).toBeNull()
  })

  it('存盘读回：只认两个 id', () => {
    // 旧文件没有 mode：按自动
    expect(parseSavedRoute({ route: 'direct' })).toEqual({ route: 'direct', mode: 'auto' })
    expect(parseSavedRoute({ route: 'cdn', mode: 'direct' })).toEqual({ route: 'cdn', mode: 'direct' })
    expect(parseSavedRoute({ route: 'x', mode: 'x' })).toEqual({ route: null, mode: 'auto' })
    expect(parseSavedRoute(null)).toEqual({ route: null, mode: 'auto' })
  })
})
