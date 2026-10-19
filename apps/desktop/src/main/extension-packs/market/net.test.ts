import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseCodedError } from '@pixelsky/protocol'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }))
vi.mock('../../account/account', () => ({ baseUrl: () => 'http://127.0.0.1:9' }))

const { downloadCapped, publicFetch } = await import('./net')

const code = (e: unknown): string | undefined => parseCodedError((e as Error)?.message)?.code

/** 可控的响应流：push 一块、end 结束；取消时记下来 */
function controlled(headers: Record<string, string> = {}, status = 200) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const state = { cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    start: c => {
      ctrl = c
    },
    cancel: () => {
      state.cancelled = true
    },
  })
  return {
    state,
    res: new Response(body, { status, headers }),
    push: (n: number) => ctrl.enqueue(new Uint8Array(n)),
    end: () => ctrl.close(),
  }
}

beforeEach(() => {
  mocks.fetch.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('publicFetch', () => {
  it('只放行 /cloud/(api/)extensions，拒绝 ..、%2e、/v1/', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}'))
    for (const path of [
      '/cloud/api/extensions/../x',
      '/cloud/api/extensions/%2E%2e/x',
      '/cloud/extensions/%2e/a.zip',
      '/v1/extensions/publisher',
      '/cloud/api/extensionsx',
      '/cloud/api/admin/extensions',
    ])
      await expect(publicFetch(path), path).rejects.toThrow()
    expect(mocks.fetch).not.toHaveBeenCalled()
    await publicFetch('/cloud/api/extensions?limit=1')
    await publicFetch('/cloud/api/extensions/blocklist')
    await publicFetch('/cloud/extensions/a.b/1.0.0.zip')
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })

  it('不带 Authorization 和 cookie，不跟随重定向；cache 原样传给 net.fetch', async () => {
    mocks.fetch.mockResolvedValue(new Response('{}'))
    await publicFetch('/cloud/api/extensions/acme.a', { cache: 'no-cache' })
    const [url, init] = mocks.fetch.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:9/cloud/api/extensions/acme.a')
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-cache' })
    expect(init.headers).toBeUndefined()
    await publicFetch('/cloud/api/extensions')
    expect('cache' in mocks.fetch.mock.calls[1][1]).toBe(false)
  })

  it('外部取消和超时都会中止请求', async () => {
    vi.useFakeTimers()
    mocks.fetch.mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    )
    const outer = new AbortController()
    const p1 = publicFetch('/cloud/api/extensions', { signal: outer.signal })
    outer.abort()
    await expect(p1).rejects.toThrow('aborted')
    const p2 = publicFetch('/cloud/api/extensions', { timeoutMs: 1000 })
    const settled = expect(p2).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(1001)
    await settled
  })
})

describe('downloadCapped', () => {
  const path = '/cloud/extensions/acme.a/1.0.0.zip'
  const fail = (p: Promise<unknown>): Promise<unknown> => p.catch((e: unknown) => e)

  it('下载完整：返回字节和响应头；请求不带令牌、no-store', async () => {
    const c = controlled({ 'x-pixelsky-ext-sha256': 'abc' })
    mocks.fetch.mockResolvedValue(c.res)
    const p = downloadCapped(path, { maxBytes: 100 })
    c.push(10)
    c.push(5)
    c.end()
    const out = await p
    expect(out.bytes.length).toBe(15)
    expect(out.headers.get('x-pixelsky-ext-sha256')).toBe('abc')
    expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    expect(mocks.fetch.mock.calls[0][1].headers).toBeUndefined()
  })

  it('路径白名单同样适用', async () => {
    await expect(downloadCapped('/v1/extensions/x', { maxBytes: 10 })).rejects.toThrow()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('Content-Length 超限：直接取消，不读数据', async () => {
    const c = controlled({ 'content-length': '101' })
    mocks.fetch.mockResolvedValue(c.res)
    expect(code(await fail(downloadCapped(path, { maxBytes: 100 })))).toBe('extstore.tooLarge')
    expect(c.state.cancelled).toBe(true)
  })

  it('Content-Length 超过详情里的 size 也拒绝', async () => {
    const c = controlled({ 'content-length': '60' })
    mocks.fetch.mockResolvedValue(c.res)
    expect(code(await fail(downloadCapped(path, { maxBytes: 100, expectSize: 50 })))).toBe('extstore.tooLarge')
  })

  it('读数据时超限（没有 Content-Length）：中止并取消流', async () => {
    const c = controlled()
    mocks.fetch.mockResolvedValue(c.res)
    const settled = fail(downloadCapped(path, { maxBytes: 100 }))
    c.push(60)
    c.push(60)
    expect(code(await settled)).toBe('extstore.tooLarge')
    await vi.waitFor(() => expect(c.state.cancelled).toBe(true))
  })

  it('读数据时超过 expectSize', async () => {
    const c = controlled()
    mocks.fetch.mockResolvedValue(c.res)
    const settled = fail(downloadCapped(path, { maxBytes: 100, expectSize: 20 }))
    c.push(21)
    expect(code(await settled)).toBe('extstore.tooLarge')
  })

  it('30 秒没有新数据算超时；有数据就重新计时', async () => {
    vi.useFakeTimers()
    const c = controlled()
    mocks.fetch.mockResolvedValue(c.res)
    const settled = fail(downloadCapped(path, { maxBytes: 100 }))
    await vi.advanceTimersByTimeAsync(29_000)
    c.push(1)
    await vi.advanceTimersByTimeAsync(29_000)
    c.push(1)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(code(await settled)).toBe('extstore.timeout')
    expect(c.state.cancelled).toBe(true)
  })

  it('总共 10 分钟的上限：一直有数据也会停', async () => {
    vi.useFakeTimers()
    const c = controlled()
    mocks.fetch.mockResolvedValue(c.res)
    const settled = fail(downloadCapped(path, { maxBytes: 10_000 }))
    for (let i = 0; i < 61 && !c.state.cancelled; i++) {
      c.push(1)
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(code(await settled)).toBe('extstore.timeout')
  })

  it('连接阶段也受时限管：30 秒还没拿到响应头', async () => {
    vi.useFakeTimers()
    mocks.fetch.mockImplementation(
      (_u: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('x')))),
    )
    const settled = fail(downloadCapped(path, { maxBytes: 100 }))
    await vi.advanceTimersByTimeAsync(30_001)
    expect(code(await settled)).toBe('extstore.timeout')
  })

  it('取消：读的过程中取消、开始前就已取消', async () => {
    const c = controlled()
    mocks.fetch.mockResolvedValue(c.res)
    const ac = new AbortController()
    const settled = fail(downloadCapped(path, { maxBytes: 100, signal: ac.signal }))
    c.push(5)
    await new Promise(r => setTimeout(r, 0))
    ac.abort()
    expect(code(await settled)).toBe('extstore.cancelled')
    expect(c.state.cancelled).toBe(true)

    mocks.fetch.mockClear()
    const done = new AbortController()
    done.abort()
    expect(code(await fail(downloadCapped(path, { maxBytes: 100, signal: done.signal })))).toBe('extstore.cancelled')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('HTTP 404 是 notFound，别的非 2xx 和网络错误是 offline', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 404 }))
    expect(code(await fail(downloadCapped(path, { maxBytes: 100 })))).toBe('extstore.notFound')
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 502 }))
    expect(code(await fail(downloadCapped(path, { maxBytes: 100 })))).toBe('extstore.offline')
    mocks.fetch.mockRejectedValueOnce(new TypeError('net::ERR_FAILED'))
    expect(code(await fail(downloadCapped(path, { maxBytes: 100 })))).toBe('extstore.offline')
  })

  it('进度节流到 250 ms：第一块立刻报，之后合并，结束时补报最后一次', async () => {
    vi.useFakeTimers()
    const c = controlled({ 'content-length': '40' })
    mocks.fetch.mockResolvedValue(c.res)
    const seen: Array<[number, number | null]> = []
    const p = downloadCapped(path, { maxBytes: 100, onProgress: (r, t) => seen.push([r, t]) })
    for (let i = 0; i < 4; i++) {
      c.push(10)
      await vi.advanceTimersByTimeAsync(100)
    }
    // 0 ms 报 10；100、200 ms 的两块被合并；300 ms 那块距上次已超 250 ms，报 40
    expect(seen).toEqual([
      [10, 40],
      [40, 40],
    ])
    c.end()
    await p
    expect(seen).toHaveLength(2)
  })
})
