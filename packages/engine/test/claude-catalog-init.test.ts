// 会话 initialize 回包更新目录缓存、后台刷新失败保留旧列表（只看缓存，不真起会话）
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const captured: { deps: { onInitialize?: (init: { models?: unknown }) => void } | null } = { deps: null }
vi.mock('../src/claude/session', async importOriginal => {
  const mod = await importOriginal<typeof import('../src/claude/session')>()
  class Fake {
    constructor(_ctx: unknown, deps: { onInitialize?: (init: { models?: unknown }) => void }) {
      captured.deps = deps
    }
  }
  return { ...mod, ClaudeSession: Fake }
})

const { ClaudeAdapter } = await import('../src')

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))
const newAdapter = (launcher = { command: process.execPath, args: [FAKE] }) =>
  new ClaudeAdapter({ launcher, env: { ...process.env }, sessionEnv: () => ({ PIXELSKY_GATEWAY_SETTINGS: '{}' }) })
type Internals = { catalogCache: { at: number; value: { models?: { id: string }[] } } | null; probing: unknown }

const record = (extra: object) => ({ ...extra })
async function init(adapter: InstanceType<typeof ClaudeAdapter>, extra: object, models: unknown) {
  ;(adapter as unknown as { cached: unknown }).cached ??= {
    launcher: { command: process.execPath, args: [FAKE] },
    info: { status: 'ready' },
  }
  adapter.createSession({ record: () => record(extra), extensions: undefined } as never)
  captured.deps!.onInitialize!({ models })
}
const RAW = [{ value: 'sonnet', displayName: 'Sonnet' }]

describe('会话回包更新目录缓存', () => {
  it('本机会话更新 models，且不延长有效期', async () => {
    const adapter = newAdapter()
    await adapter.catalog()
    const a = adapter as unknown as Internals
    a.catalogCache!.at -= 1000
    const at = a.catalogCache!.at
    await init(adapter, {}, RAW)
    expect(a.catalogCache!.value.models!.map(m => m.id)).toEqual(['sonnet'])
    expect(a.catalogCache!.at).toBe(at)
  })

  it('平台 / 自定义 API 会话不改缓存', async () => {
    for (const extra of [{ platform: { account: 'x' } }, { provider: { id: 'p' } }]) {
      const adapter = newAdapter()
      const before = (await adapter.catalog()).models
      await init(adapter, extra, RAW)
      expect((adapter as unknown as Internals).catalogCache!.value.models).toEqual(before)
    }
  })

  it('没有缓存、或回包没有模型时不动', async () => {
    const adapter = newAdapter()
    await init(adapter, {}, RAW)
    expect((adapter as unknown as Internals).catalogCache).toBeNull()
    const before = (await adapter.catalog()).models
    await init(adapter, {}, [])
    await init(adapter, {}, undefined)
    expect((adapter as unknown as Internals).catalogCache!.value.models).toEqual(before)
  })
})

describe('后台刷新', () => {
  it('后台刷新握手失败时保留旧的模型列表', async () => {
    const adapter = newAdapter()
    const first = await adapter.catalog()
    const a = adapter as unknown as Internals & { cached: { launcher: unknown } | null }
    a.catalogCache!.at = Date.now() - 31 * 60_000
    a.cached!.launcher = { command: process.execPath, args: ['-e', 'process.exit(1)'] }
    await adapter.catalog()
    await a.probing
    expect(a.catalogCache!.value.models).toEqual(first.models)
    // 失败不算新鲜：约 1 分钟后再试，不是 30 分钟
    const left = 30 * 60_000 - (Date.now() - a.catalogCache!.at)
    expect(left).toBeGreaterThan(50_000)
    expect(left).toBeLessThanOrEqual(60_000)
  })

  it('没有旧值时握手失败也不缓存满 30 分钟，约 1 分钟后再试', async () => {
    const adapter = newAdapter()
    const a = adapter as unknown as Internals & { cached: unknown }
    a.cached = { launcher: { command: process.execPath, args: ['-e', 'process.exit(1)'] }, info: { status: 'ready' } }
    expect((await adapter.catalog()).outputStyles).toEqual([])
    const left = 30 * 60_000 - (Date.now() - a.catalogCache!.at)
    expect(left).toBeGreaterThan(50_000)
    expect(left).toBeLessThanOrEqual(60_000)
  })
})
