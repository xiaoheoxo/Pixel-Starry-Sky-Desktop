// 目录缓存：后台刷新失败保留旧列表、读额度的临时进程顺手续期（docs/memory-tier2.md §1）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter } from '../src'
import { CATALOG_TTL } from '../src/claude'
import { makeTmp } from './helpers/tmp'

const FAKE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))
const newAdapter = (launcher = { command: process.execPath, args: [FAKE] }) =>
  new ClaudeAdapter({ launcher, env: { ...process.env } })
type Internals = { catalogCache: { at: number; value: { models?: { id: string }[] } } | null; probing: unknown }

describe('后台刷新', () => {
  it('后台刷新握手失败时保留旧的模型列表', async () => {
    const adapter = newAdapter()
    const first = await adapter.catalog()
    const a = adapter as unknown as Internals & { cached: { launcher: unknown } | null }
    a.catalogCache!.at = Date.now() - CATALOG_TTL - 60_000
    a.cached!.launcher = { command: process.execPath, args: ['-e', 'process.exit(1)'] }
    await adapter.catalog()
    await a.probing
    expect(a.catalogCache!.value.models).toEqual(first.models)
    // 失败不算新鲜：约 1 分钟后再试，不是等满有效期
    const left = CATALOG_TTL - (Date.now() - a.catalogCache!.at)
    expect(left).toBeGreaterThan(50_000)
    expect(left).toBeLessThanOrEqual(60_000)
  })

  it('没有旧值时握手失败也不缓存满有效期，约 1 分钟后再试', async () => {
    const adapter = newAdapter()
    const a = adapter as unknown as Internals & { cached: unknown }
    a.cached = { launcher: { command: process.execPath, args: ['-e', 'process.exit(1)'] }, info: { status: 'ready' } }
    expect((await adapter.catalog()).outputStyles).toEqual([])
    const left = CATALOG_TTL - (Date.now() - a.catalogCache!.at)
    expect(left).toBeGreaterThan(50_000)
    expect(left).toBeLessThanOrEqual(60_000)
  })
})

describe('目录少起进程（docs/memory-tier2.md §1）', () => {
  const quotaAdapter = (extra: Record<string, string> = {}) =>
    new ClaudeAdapter({
      launcher: { command: process.execPath, args: [FAKE] },
      env: { ...process.env, FAKE_CLAUDE_QUOTA: '1', ...extra },
    })
  const drop = (adapter: InstanceType<typeof ClaudeAdapter>) =>
    (adapter as unknown as { dropCatalog(): void }).dropCatalog()

  it('有效期是 6 小时', () => {
    expect(CATALOG_TTL).toBe(6 * 60 * 60_000)
  })

  it('读当前账号额度的临时进程顺手写入整份目录并续期，之后不用再握手', async () => {
    const adapter = quotaAdapter()
    await adapter.accountQuota()
    const a = adapter as unknown as Internals & { catalogCache: { value: { outputStyles: string[] } } }
    expect(a.catalogCache).not.toBeNull()
    expect(a.catalogCache!.value.outputStyles).toEqual(['default', 'Explanatory', 'Learning'])
    expect(a.catalogCache!.value.models!.length).toBeGreaterThan(0)
    expect(Date.now() - a.catalogCache!.at).toBeLessThan(10_000)
    await adapter.catalog()
    expect(a.probing).toBeNull()
  })

  it('过期的目录被读额度续期', async () => {
    const adapter = quotaAdapter()
    await adapter.catalog()
    const a = adapter as unknown as Internals
    a.catalogCache!.at = Date.now() - CATALOG_TTL - 60_000
    await adapter.accountQuota()
    expect(Date.now() - a.catalogCache!.at).toBeLessThan(10_000)
  })

  it('读额度期间清过目录（换账号、改参数）：回包不写', async () => {
    const adapter = quotaAdapter({ FAKE_CLAUDE_INIT_DELAY: '400' })
    const pending = adapter.accountQuota()
    await new Promise(r => setTimeout(r, 150))
    // 回包还没到（假进程晚 400 ms 才回 initialize）
    expect((adapter as unknown as Internals).catalogCache).toBeNull()
    drop(adapter)
    await pending
    expect((adapter as unknown as Internals).catalogCache).toBeNull()
  })
})

describe('重新检测期间读额度（docs/memory-tier2.md §1）', () => {
  it('先等正在进行的检测做完，用新的命令起进程，不把旧命令的目录写进缓存', async () => {
    const log = join(makeTmp('catalog-redetect'), 'argv.log')
    const oldLauncher = { command: process.execPath, args: [FAKE, '--old-command'] }
    const adapter = new ClaudeAdapter({
      launcher: oldLauncher,
      env: { ...process.env, FAKE_CLAUDE_QUOTA: '1', FAKE_CLAUDE_LOG: log },
    })
    await adapter.info()
    const a = adapter as unknown as {
      cached: { launcher: unknown }
      detect: () => Promise<unknown>
      discover: (force: boolean) => Promise<unknown>
    }
    // 改了替换的命令：重新检测要一会儿，检测完换成新命令
    const before = a.cached
    a.detect = async () => {
      await new Promise(r => setTimeout(r, 300))
      return { ...before, launcher: { command: process.execPath, args: [FAKE] } }
    }
    const redetect = a.discover(true)
    await adapter.accountQuota()
    await redetect
    const spawned = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as string[])
    expect(spawned.at(-1)).not.toContain('--old-command')
  })
})
