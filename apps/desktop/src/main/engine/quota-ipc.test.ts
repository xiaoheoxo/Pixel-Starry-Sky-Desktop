// 账号额度的 IPC 参数校验（docs/ui/account-quota.md §5.3、§7.2）
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))
vi.mock('../ipc/guard', () => ({
  handle: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn),
}))

import type { EngineHost } from '@pixelsky/engine'
import { DEFAULT_QUOTA_MAX_AGE_MS, quotaProvider, quotaRefreshOptions, registerQuotaIpc } from './quota-ipc'

const host = {
  accountQuota: vi.fn(async (provider: string) => ({ provider })),
  refreshAccountQuota: vi.fn(async (provider: string, opts: unknown) => ({ provider, opts })),
}
const call = (name: string, ...args: unknown[]): unknown => mocks.handlers.get(name)!({}, ...args)

beforeEach(() => {
  host.accountQuota.mockClear()
  host.refreshAccountQuota.mockClear()
  mocks.handlers.clear()
  registerQuotaIpc(host as unknown as EngineHost)
})

describe('quota IPC', () => {
  it('注册 quota:get、quota:refresh、quota:useResetCredit（quota:changed 是推送）', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual(['quota:get', 'quota:refresh', 'quota:useResetCredit'])
  })

  it('provider 只认 claude / chatgpt，其它抛「参数不对」，不碰宿主', () => {
    for (const bad of ['platform', 'codex', '', undefined, null, 1, {}, ['claude']]) {
      expect(() => quotaProvider(bad)).toThrow('参数不对')
      expect(() => call('quota:get', bad)).toThrow('参数不对')
      expect(() => call('quota:refresh', bad)).toThrow('参数不对')
    }
    expect(host.accountQuota).not.toHaveBeenCalled()
    expect(host.refreshAccountQuota).not.toHaveBeenCalled()
    expect(quotaProvider('claude')).toBe('claude')
    expect(quotaProvider('chatgpt')).toBe('chatgpt')
  })

  it('quota:get 读缓存', async () => {
    await expect(call('quota:get', 'chatgpt')).resolves.toEqual({ provider: 'chatgpt' })
    expect(host.accountQuota).toHaveBeenCalledWith('chatgpt')
  })

  it('maxAgeMs 截到 0–3600000，不是有限数用默认的 60000', () => {
    expect(DEFAULT_QUOTA_MAX_AGE_MS).toBe(60_000)
    expect(quotaRefreshOptions({ maxAgeMs: 600_000 }).maxAgeMs).toBe(600_000)
    expect(quotaRefreshOptions({ maxAgeMs: 99_999_999 }).maxAgeMs).toBe(3_600_000)
    expect(quotaRefreshOptions({ maxAgeMs: -5 }).maxAgeMs).toBe(0)
    expect(quotaRefreshOptions({ maxAgeMs: 0 }).maxAgeMs).toBe(0)
    for (const bad of [Number.NaN, Infinity, '1000', null, undefined, {}])
      expect(quotaRefreshOptions({ maxAgeMs: bad }).maxAgeMs).toBe(60_000)
    // 整个选项缺失或不是对象
    for (const bad of [undefined, null, 'force', 5, []])
      expect(quotaRefreshOptions(bad)).toEqual({ force: false, maxAgeMs: 60_000 })
  })

  it('force 只认 true', () => {
    expect(quotaRefreshOptions({ force: true }).force).toBe(true)
    for (const bad of [false, 1, 'true', {}, null, undefined])
      expect(quotaRefreshOptions({ force: bad }).force).toBe(false)
  })

  it('quota:refresh 把整理过的选项交给宿主', async () => {
    await call('quota:refresh', 'claude', { force: true, maxAgeMs: 1e12, extra: 'ignored' })
    expect(host.refreshAccountQuota).toHaveBeenCalledWith('claude', { force: true, maxAgeMs: 3_600_000 })
    await call('quota:refresh', 'chatgpt')
    expect(host.refreshAccountQuota).toHaveBeenLastCalledWith('chatgpt', { force: false, maxAgeMs: 60_000 })
  })
})
