import { describe, expect, it, vi } from 'vitest'
import {
  MAX_ZIP_BYTES,
  POLL_MS,
  canSubmit,
  canWithdraw,
  contentRows,
  extensionActions,
  failedChecks,
  groupIssues,
  liveVersion,
  maskedEmail,
  pollDelay,
  readDroppedZip,
  schedulePoll,
  versionReason,
} from './publishModel'
import { extension, issue, picked, publisherState, report, version } from './fixtures'

describe('maskedEmail', () => {
  it('只露第一个字', () => {
    expect(maskedEmail('xiao@qq.com')).toBe('x•••@qq.com')
    expect(maskedEmail('alice@example.com')).toBe('a•••@example.com')
    expect(maskedEmail(null)).toBe('')
  })
})

describe('版本状态和按钮规则', () => {
  it('只有待审核能撤回', () => {
    expect(canWithdraw(version({ status: 'pending' }))).toBe(true)
    for (const s of ['approved', 'rejected', 'withdrawn', 'blocked'] as const)
      expect(canWithdraw(version({ status: s }))).toBe(false)
  })
  it('原因：未通过写审核原因，已停用写停用原因', () => {
    expect(versionReason(version({ status: 'rejected', rejectReason: '缺少 LICENSE' }))).toBe('缺少 LICENSE')
    expect(versionReason(version({ status: 'blocked', blocked: true, blockReason: '恶意' }))).toBe('恶意')
    expect(versionReason(version({ status: 'approved' }))).toBe('')
  })
  it('下架 / 重新上架：作者下架可重新上架，平台下架不行', () => {
    expect(extensionActions(extension())).toEqual({ delist: true, relist: false })
    expect(extensionActions(extension({ delisted: true, delistedBy: 'author' }))).toEqual({
      delist: false,
      relist: true,
    })
    expect(extensionActions(extension({ delisted: true, delistedBy: 'admin' }))).toEqual({
      delist: false,
      relist: false,
    })
  })
  it('已上架版本：latestVersion 优先，否则取已上架的最后一个', () => {
    expect(liveVersion(extension({ latestVersion: '1.2.0' }))).toBe('1.2.0')
    expect(
      liveVersion(extension({ latestVersion: null, versions: [version({ version: '0.1.0', status: 'pending' })] })),
    ).toBeNull()
  })
})

describe('每 2 分钟刷新', () => {
  const pending = publisherState([extension({ versions: [version({ status: 'pending' })] })])
  const none = publisherState([extension()])
  it('pollDelay：有待审核 120000，没有 null', () => {
    expect(POLL_MS).toBe(120_000)
    expect(pollDelay(pending)).toBe(120_000)
    expect(pollDelay(none)).toBeNull()
    expect(pollDelay(null)).toBeNull()
  })
  it('schedulePoll：到点调一次；没有待审核不排；取消后不调', () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.fn()
      const cancel = schedulePoll(pending, refresh)
      vi.advanceTimersByTime(119_999)
      expect(refresh).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(refresh).toHaveBeenCalledTimes(1)
      cancel()

      const idle = vi.fn()
      schedulePoll(none, idle)
      vi.advanceTimersByTime(600_000)
      expect(idle).not.toHaveBeenCalled()

      const gone = vi.fn()
      schedulePoll(pending, gone)()
      vi.advanceTimersByTime(600_000)
      expect(gone).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('检查结果分组和提交规则', () => {
  it('分成要改的 / 建议 / 提示', () => {
    const g = groupIssues([
      issue({ zh: 'a', severity: 'error' }),
      issue({ zh: 'b', upload: 'hint' }),
      issue({ zh: 'c' }),
      issue({ zh: 'd', upload: 'reject' }),
    ])
    expect(g.reject.map(i => i.message.zh)).toEqual(['a', 'd'])
    expect(g.hint.map(i => i.message.zh)).toEqual(['b'])
    expect(g.note.map(i => i.message.zh)).toEqual(['c'])
  })
  it('canSubmit：有要改的变灰；本机没检查完能提交；前缀 / 版本号没过变灰', () => {
    const ok = picked().checks
    expect(canSubmit(report(), ok)).toBe(true)
    expect(canSubmit(report([issue({ zh: 'x', severity: 'error' })]), ok)).toBe(false)
    expect(canSubmit(report([], { blocking: 2 }), ok)).toBe(false)
    expect(canSubmit(report([], { incomplete: true }), ok)).toBe(true)
    expect(canSubmit(report(), { ...ok, prefixOk: false })).toBe(false)
    expect(canSubmit(report([], { incomplete: true }), { ...ok, versionNewer: false })).toBe(false)
    expect(failedChecks({ ...ok, prefixOk: false, versionNewer: false })).toEqual(['prefix', 'version'])
  })
})

describe('contentRows', () => {
  it('上一个上架版本里没有的种类标新增；没上架过全算新增', () => {
    const now = { grammars: [{}], snippets: [{}, {}] } as never
    const prev = { grammars: [{}] } as never
    expect(contentRows(now, prev)).toEqual([
      { kind: 'grammars', count: 1, isNew: false },
      { kind: 'snippets', count: 2, isNew: true },
    ])
    expect(contentRows(now, null).every(r => r.isNew)).toBe(true)
  })
})

describe('readDroppedZip', () => {
  const file = (name: string, size: number) => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(8))
    return { name, size, arrayBuffer }
  }
  it('超过 10 MB 拒收，不读内容', async () => {
    const f = file('a.zip', MAX_ZIP_BYTES + 1)
    expect(await readDroppedZip(f)).toEqual({ ok: false, reason: 'tooLarge' })
    expect(f.arrayBuffer).not.toHaveBeenCalled()
  })
  it('正好 10 MB 会读', async () => {
    const f = file('a.zip', MAX_ZIP_BYTES)
    expect((await readDroppedZip(f)).ok).toBe(true)
    expect(f.arrayBuffer).toHaveBeenCalledTimes(1)
  })
  it('不是 .zip 拒收', async () => {
    const f = file('a.tar', 10)
    expect(await readDroppedZip(f)).toEqual({ ok: false, reason: 'notZip' })
    expect(f.arrayBuffer).not.toHaveBeenCalled()
  })
})
