import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// 登录会话被云端吊销后，桌面端要马上退出登录；授权和换令牌时报设备名、版本号（管理页的登录会话里显示）。

const userData = mkdtempSync(join(tmpdir(), 'pixelsky-account-'))
const mocks = vi.hoisted(() => ({
  netOk: true,
  netCalls: [] as string[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  opened: [] as string[],
  windows: [] as unknown[],
  sent: [] as Array<{ to: unknown; channel: string }>,
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => userData,
    getVersion: () => '9.9.9-test',
    on: () => undefined,
  },
  BrowserWindow: { getAllWindows: () => mocks.windows },
  net: {
    fetch: async (url: string) => {
      mocks.netCalls.push(url)
      if (!mocks.netOk) throw new TypeError('net down')
      return new Response('{}', { status: 200 })
    },
  },
  // 测试里「加密」就是原样：只要读写对得上
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  shell: {
    openExternal: async (url: string) => {
      mocks.opened.push(url)
    },
  },
}))
vi.mock('../app/ui-language', () => ({ nativeText: (_w: unknown, v: string) => v, windowLocale: () => 'zh-CN' }))
vi.mock('../app/rendererHealth', () => ({
  sendTo: (wc: unknown, channel: string) => {
    mocks.sent.push({ to: wc, channel })
    return true
  },
}))
vi.mock('../ipc/guard', () => ({
  handle: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn),
}))

const requests: Array<{
  path: string
  body: Record<string, unknown> | null
  raw: unknown
  headers: Headers
  method: string
}> = []
let revoked = false
let globalDown = false
/** 不为 null 时，/v1/platform/slow 的响应要等它 resolve 才回（模拟请求途中账号退出） */
let slowGate: Promise<void> | null = null
vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
  if (globalDown) throw new TypeError('fetch failed')
  const path = new URL(input).pathname
  requests.push({
    path,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    raw: init.body,
    headers: new Headers(init.headers),
    method: init.method ?? 'GET',
  })
  if (path === '/v1/platform/slow' && slowGate) await slowGate
  if (path.startsWith('/v1/extensions')) return Response.json({ ok: true }, { status: 200 })
  if (path === '/v1/oauth/token' && revoked) return Response.json({ error: 'invalid_grant' }, { status: 400 })
  // 软件内付款：面板凭证的问题云端回 403 + code（不是 401），不能被当成登录过期
  if (path === '/v1/platform/reauth')
    return Response.json({ error: '需要确认账号', code: 'PANEL_REAUTH_REQUIRED' }, { status: 403 })
  if (path.startsWith('/v1/platform/')) return Response.json({}, { status: revoked ? 401 : 200 })
  // 账号数据读不到只是暂时故障：保持登录
  return Response.json({}, { status: 503 })
})

writeFileSync(
  join(userData, 'account.json'),
  JSON.stringify({
    version: 1,
    data: Buffer.from(
      JSON.stringify({
        tokens: { accessToken: 'pss_a', refreshToken: 'pssr_r', accessExpiresAt: Date.now() + 3600_000 },
        account: { email: 'alice@example.com', name: 'Alice' },
      }),
    ).toString('base64'),
  }),
)

const { deviceName, extensionsFetch, initAccount, platformFetch, signedInEmail } = await import('./account')
const { markPayWindow } = await import('../app/payWindowRegistry')
vi.useFakeTimers({ toFake: ['setInterval'] })
initAccount()

afterAll(() => {
  vi.useRealTimers()
})

describe('extensionsFetch', () => {
  it('带登录令牌请求 /v1/extensions，JSON 体和原始字节都能发', async () => {
    requests.length = 0
    expect((await extensionsFetch('GET', '/v1/extensions/publisher')).status).toBe(200)
    expect(requests[0].headers.get('Authorization')).toBe('Bearer pss_a')

    await extensionsFetch('POST', '/v1/extensions/publisher', { body: { name: 'acme' } })
    expect(requests[1].body).toEqual({ name: 'acme' })
    expect(requests[1].headers.get('Content-Type')).toBe('application/json')

    const bytes = new Uint8Array([80, 75, 3, 4])
    await extensionsFetch('POST', '/v1/extensions/upload', { raw: bytes, contentType: 'application/zip' })
    expect(requests[2].raw).toBe(bytes)
    expect(requests[2].headers.get('Content-Type')).toBe('application/zip')
  })

  it('白名单外和带 .. / %2e 的路径在发请求前就被拒', async () => {
    requests.length = 0
    for (const path of [
      '/v1/platform/x',
      '/v1/extensionsx',
      '/v1/extensions/../platform',
      '/v1/extensions/%2e%2e/x',
      '/v1/extensions/%2E%2e/x',
      '/cloud/api/extensions',
    ])
      await expect(extensionsFetch('GET', path), path).rejects.toThrow()
    expect(requests).toEqual([])
  })
})

describe('extensionsFetch 的代理提示', () => {
  it('全局 fetch 连不上而公开请求（net.fetch）通：extstore.proxyHint', async () => {
    mocks.netCalls.length = 0
    mocks.netOk = true
    globalDown = true
    try {
      await expect(extensionsFetch('GET', '/v1/extensions/publisher')).rejects.toThrow('extstore.proxyHint')
      expect(mocks.netCalls).toHaveLength(1)
      const url = new URL(mocks.netCalls[0])
      expect(url.pathname + url.search).toBe('/cloud/api/extensions?limit=1')
    } finally {
      globalDown = false
    }
  })

  it('两个都不通：原样抛网络错误（api 层映射成 offline）', async () => {
    mocks.netOk = false
    globalDown = true
    try {
      const e = await extensionsFetch('GET', '/v1/extensions/publisher').catch((x: unknown) => x)
      expect(e).toBeInstanceOf(TypeError)
    } finally {
      globalDown = false
      mocks.netOk = true
    }
  })

  it('请求通就不试公开接口；白名单外的路径也不试', async () => {
    mocks.netCalls.length = 0
    await extensionsFetch('GET', '/v1/extensions/publisher')
    await expect(extensionsFetch('GET', '/v1/platform/x')).rejects.toThrow()
    expect(mocks.netCalls).toEqual([])
  })
})

describe('platformFetch 的 403', () => {
  it('403 + code 原样返回：不续期、不退出登录', async () => {
    requests.length = 0
    const res = await platformFetch('/v1/platform/reauth', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'PANEL_REAUTH_REQUIRED' })
    expect(requests.map(r => r.path)).toEqual(['/v1/platform/reauth'])
    expect(signedInEmail()).toBe('alice@example.com')
  })
})

describe('登录会话', () => {
  it('被吊销后平台请求失败即退出登录，并报出原因；刷新令牌时带版本号', async () => {
    expect(signedInEmail()).toBe('alice@example.com')
    expect((await platformFetch('/v1/platform/groups')).status).toBe(200)

    // 另一个请求还在途中时账号退出：它回来后也抛 AUTH_EXPIRED（调用方按「需要登录」处理，不当成断网）
    let release!: () => void
    slowGate = new Promise<void>(resolve => (release = resolve))
    const inFlight = platformFetch('/v1/platform/slow').catch((e: unknown) => e)

    revoked = true
    const error = await platformFetch('/v1/platform/groups').catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'AUTH_EXPIRED', message: expect.stringContaining('请重新登录') })
    release()
    slowGate = null
    expect(await inFlight).toMatchObject({ code: 'AUTH_EXPIRED', message: '账号已退出，请重新登录' })
    expect(signedInEmail()).toBeNull()
    expect(existsSync(join(userData, 'account.json'))).toBe(false)
    expect(requests.find(r => r.path === '/v1/oauth/token')?.body).toMatchObject({
      grant_type: 'refresh_token',
      client_version: '9.9.9-test',
    })
  })

  it('退出后重新登录：授权地址带设备名', async () => {
    void mocks.handlers.get('account:login')?.()
    await vi.waitFor(() => expect(mocks.opened).toHaveLength(1))
    expect(new URL(mocks.opened[0]).searchParams.get('device_name')).toBe(deviceName())
    expect(deviceName()).toMatch(/ · |^(Windows|macOS|Linux)/)
    await mocks.handlers.get('account:cancel')?.()
  })

  it('登录中的状态带核对码和授权页地址；在授权页点了取消：未登录，原因是 denied（欢迎页据此提示）', async () => {
    mocks.opened.length = 0
    void mocks.handlers.get('account:login')?.()
    await vi.waitFor(() => expect(mocks.opened).toHaveLength(1))
    const signingIn = mocks.handlers.get('account:get')?.() as { status: string; authCode: string; url?: string }
    expect(signingIn).toMatchObject({ status: 'signing-in', url: mocks.opened[0] })
    expect(new URL(mocks.opened[0]).searchParams.get('auth_code')).toBe(signingIn.authCode)
    // 模拟浏览器回调：授权页上点了取消
    const authorize = new URL(mocks.opened[0])
    const callback = new URL(authorize.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({
      state: authorize.searchParams.get('state')!,
      error: 'access_denied',
    }).toString()
    const { get } = await import('node:http')
    await new Promise<void>((resolve, reject) =>
      get(callback, res => (res.resume(), res.on('end', resolve))).on('error', reject),
    )
    expect(mocks.handlers.get('account:get')?.()).toEqual({ status: 'signed-out', reason: 'denied' })
  })

  it('account:changed 只广播给软件自己的窗口，不发给付款窗口（第三方收银台页）', async () => {
    const fake = () => ({ isDestroyed: () => false, webContents: {} })
    const main = fake()
    const pay = fake()
    markPayWindow(pay as never)
    mocks.windows = [main, pay]
    mocks.sent.length = 0
    mocks.opened.length = 0
    try {
      void mocks.handlers.get('account:login')?.()
      await vi.waitFor(() => expect(mocks.opened).toHaveLength(1))
      const targets = mocks.sent.filter(s => s.channel === 'account:changed').map(s => s.to)
      expect(targets).toContain(main.webContents)
      expect(targets).not.toContain(pay.webContents)
      await mocks.handlers.get('account:cancel')?.()
    } finally {
      mocks.windows = []
    }
  })
})
