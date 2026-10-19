import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanTemp, tempDir } from '../testing'
import { readBlocklistFile, type BlocklistFile } from './blocklist'
import {
  createBlocklistSync,
  FIRST_READ_MS,
  READ_INTERVAL_MS,
  REFRESH_MIN_MS,
  STALE_MS,
  type BlocklistSyncDeps,
} from './blocklist-sync'

const SITE = 'https://auth.pixelstarrysky.xyz'
const OTHER = 'http://127.0.0.1:8080'

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-17T00:00:00Z') }))
afterEach(() => {
  vi.useRealTimers()
  cleanTemp()
})

function setup(over: Partial<BlocklistSyncDeps> = {}) {
  const file = join(tempDir('bl-'), 'blocklist.json')
  const applied: BlocklistFile[] = []
  const logs: string[] = []
  const blocklist = vi.fn(async () => ({
    updatedAt: 'u1',
    items: [{ id: 'acme.aa', versions: '*' as const, reason: 'bad' }, { nonsense: true }],
  }))
  const sync = createBlocklistSync({
    file,
    site: () => SITE,
    api: { blocklist },
    apply: async l => void applied.push(l),
    log: m => logs.push(m),
    ...over,
  })
  return { file, applied, logs, blocklist, sync }
}

describe('createBlocklistSync', () => {
  it('启动 15 秒后读一次，之后每 6 小时读一次；stop 后不再读', async () => {
    const { sync, blocklist } = setup()
    sync.start()
    await vi.advanceTimersByTimeAsync(FIRST_READ_MS - 1)
    expect(blocklist).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(blocklist).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(blocklist).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS)
    expect(blocklist).toHaveBeenCalledTimes(3)
    sync.stop()
    await vi.advanceTimersByTimeAsync(READ_INTERVAL_MS * 2)
    expect(blocklist).toHaveBeenCalledTimes(3)
  })

  it('读到后：形状不对的条目丢掉，按站点原子存盘，交给 apply', async () => {
    const { sync, file, applied } = setup()
    const st = await sync.refresh(true)
    expect(st.blocklistAt).toBe('2026-10-17T00:00:00.000Z')
    const saved = readBlocklistFile(file)
    expect(saved.sites[SITE].items).toEqual([{ id: 'acme.aa', versions: '*', reason: 'bad' }])
    expect(saved.sites[SITE].updatedAt).toBe('u1')
    expect(applied).toHaveLength(1)
    expect(applied[0]).toEqual(saved)
    expect(existsSync(`${file}.tmp-${process.pid}`)).toBe(false)
  })

  it('多站点：别的站点已存的名单保留', async () => {
    const { sync, file } = setup()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sites: {
          [OTHER]: {
            fetchedAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '',
            items: [{ id: 'acme.bb', versions: ['1.0.0'], reason: 'x' }],
          },
        },
      }),
    )
    await sync.refresh(true)
    const saved = readBlocklistFile(file)
    expect(Object.keys(saved.sites).sort()).toEqual([OTHER, SITE].sort())
    expect(saved.sites[OTHER].items).toHaveLength(1)
  })

  it('5 分钟节流：不足 5 分钟不真读，force 和过了 5 分钟才读；同时进行的只读一次', async () => {
    const { sync, blocklist } = setup()
    await sync.refresh()
    await sync.refresh()
    expect(blocklist).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(REFRESH_MIN_MS - 1)
    await sync.refresh()
    expect(blocklist).toHaveBeenCalledTimes(1)
    await sync.refresh(true)
    expect(blocklist).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(REFRESH_MIN_MS)
    await Promise.all([sync.refresh(), sync.refresh()])
    expect(blocklist).toHaveBeenCalledTimes(3)
  })

  it('读失败：保留上一份名单、不 apply、不抛错，也不重写文件', async () => {
    const { sync, file, applied, blocklist, logs } = setup()
    await sync.refresh(true)
    const before = readFileSync(file, 'utf8')
    blocklist.mockRejectedValueOnce(new Error('offline'))
    await vi.advanceTimersByTimeAsync(REFRESH_MIN_MS)
    const st = await sync.refresh()
    expect(st.blocklistAt).toBe('2026-10-17T00:00:00.000Z')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(applied).toHaveLength(1)
    expect(logs.some(l => l.includes('read failed'))).toBe(true)
  })

  it('3 天没读到：status.stale 为 true，失败时日志里写明；读到后恢复', async () => {
    const { sync, blocklist, logs } = setup()
    await sync.refresh(true)
    expect(sync.status().stale).toBe(false)
    blocklist.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(STALE_MS + 1000)
    expect(sync.status().stale).toBe(true)
    await sync.refresh(true)
    expect(logs.at(-1)).toContain('over 3 days')
    blocklist.mockResolvedValue({ updatedAt: '', items: [] })
    await sync.refresh(true)
    expect(sync.status().stale).toBe(false)
  })

  it('从没读到过名单时从启动算 3 天；没文件时 blocklistAt 是 null', async () => {
    const { sync } = setup()
    expect(sync.status()).toEqual({ blocklistAt: null, stale: false })
    await vi.advanceTimersByTimeAsync(STALE_MS + 1000)
    expect(sync.status()).toEqual({ blocklistAt: null, stale: true })
  })

  it('站点换了：状态只看当前站点的那份', async () => {
    let site = SITE
    const { sync } = setup({ site: () => site })
    await sync.refresh(true)
    expect(sync.status().blocklistAt).not.toBeNull()
    site = OTHER
    expect(sync.status().blocklistAt).toBeNull()
  })
})
