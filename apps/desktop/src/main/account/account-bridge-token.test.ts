import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// 长连接的令牌（团队实时通道、手机中转各一条）：云端每刷新一次就让旧的访问令牌失效。
// 一条被拒后如果当前令牌已经是别处刷新出来的新令牌，直接用，不再刷新——不然两条连接会互相把对方的令牌刷掉，每分钟断一次。

const userData = mkdtempSync(join(tmpdir(), 'pixelsky-bridge-token-'))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => userData, getVersion: () => '9.9.9-test', on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  powerMonitor: { on: () => undefined },
  net: { fetch: async () => new Response('{}', { status: 200 }) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  shell: { openExternal: async () => undefined },
}))
vi.mock('../app/ui-language', () => ({ nativeText: (_w: unknown, v: string) => v, windowLocale: () => 'zh-CN' }))
vi.mock('../ipc/guard', () => ({ handle: () => undefined }))

let refreshes = 0
vi.stubGlobal('fetch', (input: string) => {
  if (new URL(input).pathname === '/v1/oauth/token') {
    refreshes++
    return Promise.resolve(
      Response.json({ access_token: 'pss_' + refreshes, refresh_token: 'pssr_' + refreshes, expires_in: 3600 }),
    )
  }
  return Promise.resolve(Response.json({ email: 'alice@example.com', balance: 1 }))
})

writeFileSync(
  join(userData, 'account.json'),
  JSON.stringify({
    version: 1,
    data: Buffer.from(
      JSON.stringify({
        tokens: { accessToken: 'pss_0', refreshToken: 'pssr_0', accessExpiresAt: Date.now() + 3600_000 },
        account: { email: 'alice@example.com', name: 'Alice', balance: 1, currency: 'USD', updatedAt: 1 },
      }),
    ).toString('base64'),
  }),
)

const { initAccount, bridgeTokenSource } = await import('./account')
initAccount()

describe('长连接取令牌', () => {
  it('两条连接交替被拒：当前令牌已比被拒的新就直接用，只有当前这份被拒才刷新', async () => {
    const team = bridgeTokenSource(),
      relay = bridgeTokenSource()
    expect(await team(false)).toBe('pss_0')
    expect(await relay(false)).toBe('pss_0')
    // 团队通道被拒（pss_0 是当前令牌）：刷新一次
    expect(await team(true)).toBe('pss_1')
    expect(refreshes).toBe(1)
    // 中转被拒的是旧的 pss_0，当前已经是 pss_1：直接用，不再刷新（以前这里会再刷一次，把团队通道的 pss_1 刷掉）
    expect(await relay(true)).toBe('pss_1')
    expect(refreshes).toBe(1)
    // 当前这份也被拒了（比如会话被撤销）：才刷新
    expect(await relay(true)).toBe('pss_2')
    expect(refreshes).toBe(2)
  })
})
