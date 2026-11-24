import { describe, expect, it } from 'vitest'
import {
  BIG_REQUEST_AVOID_MS,
  BIG_REQUEST_SLOW_MS,
  BigRoute,
  CLOUD_ROUTES,
  LOGIN_PROBE_FRESH_MS,
  SWITCH_MARGIN_MS,
  parseSavedRoute,
  pickRoute,
  probeBeforeLogin,
  probeRoute,
  wsRoute,
} from './cloud-route'

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

describe('登录前要不要先测速（docs/network-direct.md §8）', () => {
  const now = 1_000_000
  const ok = (id: 'cdn' | 'direct', ms: number | null) => ({ id, ms })
  it('还没测过、测速超过一分钟要先测', () => {
    expect(probeBeforeLogin('cdn', [], 0, now)).toBe(true)
    expect(probeBeforeLogin('cdn', [ok('cdn', 300), ok('direct', 500)], now - LOGIN_PROBE_FRESH_MS, now)).toBe(true)
  })
  it('刚测过：当前这条不通要重测（CDN 炸了还停在 CDN），通就直接用', () => {
    expect(probeBeforeLogin('cdn', [ok('cdn', null), ok('direct', 500)], now - 1_000, now)).toBe(true)
    expect(probeBeforeLogin('direct', [ok('cdn', null), ok('direct', 500)], now - 1_000, now)).toBe(false)
    expect(probeBeforeLogin(null, [ok('cdn', 300), ok('direct', 500)], now - 1_000, now)).toBe(false)
  })
})

describe('wsRoute：长连接走哪条', () => {
  it('自动模式固定走直连（CDN 去掉 WebSocket 升级头）；直连上次测不通才走 CDN；用户指定了就按指定的', () => {
    expect(wsRoute('auto', [])).toBe('direct')
    expect(wsRoute('auto', [r('cdn', 100), r('direct', 900)])).toBe('direct')
    expect(wsRoute('auto', [r('cdn', 100), r('direct', null)])).toBe('cdn')
    expect(wsRoute('cdn', [r('cdn', 100), r('direct', 50)])).toBe('cdn')
    expect(wsRoute('direct', [r('direct', null)])).toBe('direct')
  })
})

describe('大请求选线路（docs/ui/pixel-request-size.md §7）', () => {
  const both = [r('cdn', 100), r('direct', 900)]
  const ok = new Response('ok')
  const refused = new Error('refused')
  const notConnected = (e: unknown): boolean => e === refused

  it('不看延迟，先直连；直连测不通就用选中的', () => {
    const big = new BigRoute()
    expect(big.pick('cdn', both, 0)).toBe('direct')
    expect(big.pick('cdn', [], 0)).toBe('direct')
    expect(big.pick('cdn', [r('cdn', 100), r('direct', null)], 0)).toBe('cdn')
  })

  it('没连上换另一条重发，只换一次；别的失败不重发', async () => {
    const used: string[] = []
    const send = async (id: string): Promise<Response> => {
      used.push(id)
      if (id === 'direct') throw refused
      return ok
    }
    expect(await new BigRoute().send('direct', both, send, notConnected)).toBe(ok)
    expect(used).toEqual(['direct', 'cdn'])
    used.length = 0
    const down = async (id: string): Promise<Response> => {
      used.push(id)
      throw refused
    }
    await expect(new BigRoute().send('cdn', both, down, notConnected)).rejects.toBe(refused)
    expect(used).toEqual(['direct', 'cdn'])
    used.length = 0
    const reset = async (id: string): Promise<Response> => {
      used.push(id)
      throw new Error('reset')
    }
    await expect(new BigRoute().send('cdn', both, reset, notConnected)).rejects.toThrow('reset')
    expect(used).toEqual(['direct'])
  })

  it('很久没等到响应头就断开：一段时间内走另一条；断得快的（用户停了）不算', async () => {
    let t = 0
    const big = new BigRoute()
    const abort = (ms: number) => async (): Promise<Response> => {
      t += ms
      throw new Error('aborted')
    }
    const run = (ms: number): Promise<unknown> =>
      big.send('cdn', both, abort(ms), notConnected, () => t).catch(() => undefined)
    await run(BIG_REQUEST_SLOW_MS - 1)
    expect(big.pick('cdn', both, t)).toBe('direct')
    await run(BIG_REQUEST_SLOW_MS)
    expect(big.pick('cdn', both, t)).toBe('cdn')
    expect(big.pick('cdn', both, t + BIG_REQUEST_AVOID_MS)).toBe('direct')
    // 换过去的也传不动：换回来
    await run(BIG_REQUEST_SLOW_MS)
    expect(big.pick('cdn', both, t)).toBe('direct')
  })
})
