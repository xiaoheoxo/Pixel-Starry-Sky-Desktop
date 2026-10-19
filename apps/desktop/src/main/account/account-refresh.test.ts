import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// 手动刷新（account:refresh）：一定发点击之后的新请求；失败原因和刷新后的账号随结果返回。

const userData = mkdtempSync(join(tmpdir(), 'pixelsky-account-refresh-'))
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => userData, getVersion: () => '9.9.9-test', on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: async () => new Response('{}', { status: 200 }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  shell: { openExternal: async () => undefined },
}))
vi.mock('../app/ui-language', () => ({ nativeText: (_w: unknown, v: string) => v, windowLocale: () => 'zh-CN' }))
vi.mock('../ipc/guard', () => ({
  handle: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn),
}))

/** 每个 /v1/oauth/account 请求停在这里，测试按顺序放行并决定响应 */
const pending: Array<(res: Response) => void> = []
let accountRequests = 0
vi.stubGlobal('fetch', (input: string) => {
  if (new URL(input).pathname !== '/v1/oauth/account') return Promise.resolve(Response.json({}, { status: 404 }))
  accountRequests++
  return new Promise<Response>(resolve => pending.push(resolve))
})
const accountBody = (balance: number): Response => Response.json({ email: 'alice@example.com', balance })

writeFileSync(
  join(userData, 'account.json'),
  JSON.stringify({
    version: 1,
    data: Buffer.from(
      JSON.stringify({
        tokens: { accessToken: 'pss_a', refreshToken: 'pssr_r', accessExpiresAt: Date.now() + 3600_000 },
        account: { email: 'alice@example.com', name: 'Alice', balance: 1, currency: 'USD', updatedAt: 1 },
      }),
    ).toString('base64'),
  }),
)

const { initAccount } = await import('./account')
vi.useFakeTimers({ toFake: ['setInterval'] })
initAccount() // 启动时就发了第一次请求（停在 pending[0]）

afterAll(() => {
  vi.useRealTimers()
})

type Result = { error: string | null; account: { balance: number | null } | null }
const refresh = (): Promise<Result> => mocks.handlers.get('account:refresh')!() as Promise<Result>
const release = async (res: Response): Promise<void> => {
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
  pending.shift()!(res)
}

describe('account:refresh 手动刷新', () => {
  it('已有请求在途（读的是点击之前的数据）时，等它结束后再发一次；多次点击共用这一次后续请求', async () => {
    expect(accountRequests).toBe(1) // 启动时的请求还没回
    const a = refresh()
    const b = refresh()
    await Promise.resolve()
    expect(accountRequests).toBe(1) // 后续请求要等在途的结束才发

    await release(accountBody(10)) // 在途请求（点击之前发出的）返回旧数据 10
    await vi.waitFor(() => expect(accountRequests).toBe(2)) // 后续请求发出
    await release(accountBody(25)) // 点击之后的数据 25

    const [ra, rb] = await Promise.all([a, b])
    expect(accountRequests).toBe(2)
    expect(ra).toMatchObject({ error: null, account: { balance: 25 } })
    expect(rb).toMatchObject({ error: null, account: { balance: 25 } })
  })

  it('没有请求在途：只发一次，结果带刷新后的账号', async () => {
    const before = accountRequests
    const r = refresh()
    await release(accountBody(30))
    expect(await r).toMatchObject({ error: null, account: { balance: 30 } })
    expect(accountRequests).toBe(before + 1)
  })

  it('读取失败：结果带错误原因，保留旧账号数据，不吞掉错误', async () => {
    const r = refresh()
    await release(Response.json({}, { status: 503 }))
    const res = await r
    expect(res.error).toBe('服务暂时不可用')
    expect(res.account).toMatchObject({ balance: 30 })
  })

  it('失败之后再刷新成功，错误清掉', async () => {
    const r = refresh()
    await release(accountBody(31))
    expect(await r).toMatchObject({ error: null, account: { balance: 31 } })
  })
})
