import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHECK_INTERVAL, fetchBuild, isNewBuild, loadPage, parseBuild, watchNewBuild } from './version'

describe('parseBuild / isNewBuild', () => {
  it('reads the build id out of version.json', () => {
    expect(parseBuild({ build: ' 202610171530-ab12cd3 ' })).toBe('202610171530-ab12cd3')
    for (const bad of [null, undefined, 'x', {}, { build: 5 }, { build: '  ' }]) expect(parseBuild(bad)).toBeNull()
  })
  it('only a different, known build counts as new', () => {
    expect(isNewBuild('a', 'b')).toBe(true)
    expect(isNewBuild('a', 'a')).toBe(false)
    expect(isNewBuild('a', null)).toBe(false)
    expect(isNewBuild('', 'b')).toBe(false)
  })
})

describe('fetchBuild', () => {
  const reply = (body: () => Promise<unknown>, ok = true) => vi.fn(async () => ({ ok, json: body }) as Response)
  it('asks for version.json next to the page without using the cache', async () => {
    const f = reply(async () => ({ build: 'b1' }))
    expect(await fetchBuild('/m/', f)).toBe('b1')
    expect(f).toHaveBeenCalledWith('/m/version.json', { cache: 'no-store' })
  })
  it('gives null on errors, non-JSON (index.html fallback) and bad status', async () => {
    expect(
      await fetchBuild(
        '/m/',
        reply(async () => ({}), false),
      ),
    ).toBeNull()
    expect(
      await fetchBuild(
        '/m/',
        reply(() => Promise.reject(new SyntaxError('not json'))),
      ),
    ).toBeNull()
    expect(await fetchBuild('/m/', vi.fn().mockRejectedValue(new TypeError('offline')))).toBeNull()
  })
})

describe('watchNewBuild', () => {
  afterEach(() => vi.useRealTimers())

  function setup(remote: string | null) {
    vi.useFakeTimers()
    let visible = true
    let onVis: () => void = () => {}
    const state = { remote }
    const fetchRemote = vi.fn(async () => state.remote)
    const onNew = vi.fn()
    const stop = watchNewBuild(onNew, {
      current: 'a',
      fetchRemote,
      visible: () => visible,
      onVisibility: h => {
        onVis = h
        return () => {
          onVis = () => {}
        }
      },
      setTimer: (h, ms) => setTimeout(h, ms),
      clearTimer: id => clearTimeout(id as ReturnType<typeof setTimeout>),
    })
    return {
      state,
      fetchRemote,
      onNew,
      stop,
      show: () => {
        visible = true
        onVis()
      },
      hide: () => {
        visible = false
        onVis()
      },
    }
  }

  it('checks every 10 minutes and reports a new build once', async () => {
    const w = setup('a')
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL)
    expect(w.fetchRemote).toHaveBeenCalledTimes(1)
    expect(w.onNew).not.toHaveBeenCalled()
    w.state.remote = 'b'
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL)
    expect(w.onNew).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL * 3) // 报过之后不再取
    expect(w.fetchRemote).toHaveBeenCalledTimes(2)
  })

  it('checks when the page comes back to the foreground, not when it goes away', async () => {
    const w = setup('b')
    w.hide()
    expect(w.fetchRemote).not.toHaveBeenCalled()
    w.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.onNew).toHaveBeenCalledTimes(1)
  })

  it('does not fetch on the timer while in the background, and stop() ends everything', async () => {
    const w = setup('b')
    w.hide()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL * 2)
    expect(w.fetchRemote).not.toHaveBeenCalled()
    w.stop()
    w.show()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL * 2)
    expect(w.fetchRemote).not.toHaveBeenCalled()
  })
})

describe('loadPage', () => {
  const store = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  })
  afterEach(() => store.clear())

  it('passes a good module through', async () => {
    expect(
      await loadPage(
        async () => 5,
        vi.fn(),
        async () => true,
      ),
    ).toBe(5)
  })
  it('reloads once when a new build is out, then gives the error up', async () => {
    const reload = vi.fn()
    const bad = () => Promise.reject(new Error('chunk 404'))
    void loadPage(bad, reload, async () => true) // 不会 resolve：页面马上刷新
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    await expect(loadPage(bad, reload, async () => true)).rejects.toThrow('chunk 404')
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it('does not reload when there is no new build (offline, flaky network)', async () => {
    const reload = vi.fn()
    const bad = () => Promise.reject(new Error('network'))
    await expect(loadPage(bad, reload, async () => false)).rejects.toThrow('network')
    await expect(loadPage(bad, reload, () => Promise.reject(new Error('offline')))).rejects.toThrow('network')
    expect(reload).not.toHaveBeenCalled()
  })
})
