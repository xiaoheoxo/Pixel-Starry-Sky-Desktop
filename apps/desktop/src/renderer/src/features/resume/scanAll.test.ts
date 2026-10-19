// 设置 › 项目「原来的 AI 会话」：扫描全部项目的状态和显示（docs/ui/resume-scan-mockup.html）
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { EngineConfig, NativeSessionSummary } from '@pixelsky/protocol'
import {
  cachedResumeCounts,
  engineScan,
  noteEngineConfig,
  resetResumeHints,
  scanCounts,
  scanResumeProject,
  type ProjectScan,
} from './hint'
import {
  SCAN_CONCURRENCY,
  getResumeScan,
  rescanProject,
  resetResumeScan,
  rowEngines,
  rowLatest,
  scanAllProjects,
  scanView,
  stopResumeScan,
  type ScanRow,
} from './scanAll'

const session = (id: string, updatedAt: number, extra: Partial<NativeSessionSummary> = {}): NativeSessionSummary =>
  ({ id, updatedAt, ownerId: null, live: null, ...extra }) as unknown as NativeSessionSummary
const found = (claude: number, codex: number, latest = 1000): ProjectScan => ({
  claude: { count: claude, live: 0, latest: claude ? latest : null, error: null },
  codex: { count: codex, live: 0, latest: codex ? latest + 1 : null, error: null },
})

afterEach(() => {
  resetResumeScan()
  resetResumeHints()
})

describe('engineScan / scanResumeProject', () => {
  it('只算没被像素星空占用的；数出正开着的和最近一个', () => {
    expect(
      engineScan([
        session('a', 100),
        session('b', 300, { live: 'terminal' }),
        session('c', 900, { ownerId: 'pixelsky-session' }),
        // 'maybe' 只是按修改时间猜的，不算正开着
        session('d', 200, { live: 'maybe' }),
      ]),
    ).toEqual({ count: 3, live: 1, latest: 300, error: null })
    expect(engineScan([])).toEqual({ count: 0, live: 0, latest: null, error: null })
  })

  it('不看缓存重新查；一个引擎读不到只记它自己的原因；结果写回提示缓存', async () => {
    let calls = 0
    resetResumeHints(async (_p, engine) => {
      calls++
      if (engine === 'codex') throw new Error('Codex 没装好')
      return [session('a', 5), session('b', 7)]
    })
    const scan = await scanResumeProject('p1')
    expect(scan.claude).toEqual({ count: 2, live: 0, latest: 7, error: null })
    expect(scan.codex).toEqual({ count: 0, live: 0, latest: null, error: 'Codex 没装好' })
    expect(cachedResumeCounts('p1')).toEqual({ claude: 2 })
    await scanResumeProject('p1')
    expect(calls).toBe(4)
  })

  it('扫的途中改了 CODEX_HOME：按新配置再扫一次，缓存里是新目录的数字', async () => {
    const config = (home: string): EngineConfig =>
      ({
        claude: { path: null, args: [], env: {} },
        codex: { path: null, args: [], env: { CODEX_HOME: home } },
      }) as unknown as EngineConfig
    let home = 'A'
    let calls = 0
    resetResumeHints(async (_p, engine) => {
      calls++
      const at = home
      // 第一次查 Codex 时用户正好改了目录
      if (engine === 'codex' && at === 'A') {
        home = 'B'
        noteEngineConfig(config('B'))
      }
      return engine === 'codex' ? Array.from({ length: at === 'A' ? 1 : 4 }, (_, i) => session(`s${i}`, i)) : []
    })
    noteEngineConfig(config('A'))
    const scan = await scanResumeProject('p-gen')
    expect(scan.codex?.count).toBe(4)
    expect(cachedResumeCounts('p-gen')).toEqual({ codex: 4 })
    expect(calls).toBe(4)
  })

  it('scanCounts 只留有会话的引擎', () => {
    expect(scanCounts(found(0, 3))).toEqual({ codex: 3 })
    expect(scanCounts({})).toEqual({})
  })
})

describe('scanAllProjects', () => {
  it('本机项目排队扫（同时最多 SCAN_CONCURRENCY 个），远程项目直接标不支持', async () => {
    let running = 0
    let peak = 0
    const scan = vi.fn(async (id: string) => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 2))
      running--
      return id === 'p3' ? found(1, 0) : found(0, 0)
    })
    const projects = [...Array.from({ length: 9 }, (_, i) => ({ id: `p${i}` })), { id: 'ssh-1a2b~r1' }]
    await scanAllProjects(projects, id => !id.startsWith('ssh-'), scan)
    const s = getResumeScan()
    expect(s.running).toBe(false)
    expect(s.finishedAt).not.toBeNull()
    expect(scan).toHaveBeenCalledTimes(9)
    expect(peak).toBeLessThanOrEqual(SCAN_CONCURRENCY)
    expect(s.rows.find(r => r.projectId === 'ssh-1a2b~r1')?.state).toBe('remote')
    expect(s.rows.filter(r => r.state === 'done')).toHaveLength(9)
    expect(rowEngines(s.rows.find(r => r.projectId === 'p3')!)).toEqual(['claude'])
  })

  it('停止：在扫的扫完，排队的不再扫，留在「没扫」', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const scan = vi.fn(async () => {
      await gate
      return found(1, 1)
    })
    const projects = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}` }))
    const run = scanAllProjects(projects, () => true, scan)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(SCAN_CONCURRENCY))
    stopResumeScan()
    expect(getResumeScan().stopping).toBe(true)
    release()
    await run
    expect(scan).toHaveBeenCalledTimes(SCAN_CONCURRENCY)
    const view = scanView(getResumeScan(), true)
    expect(view.done).toBe(SCAN_CONCURRENCY)
    expect(view.hiddenSkipped).toBe(10 - SCAN_CONCURRENCY)
  })

  it('已经在扫时不重复开始；单个项目可以重扫', async () => {
    let n = 0
    const scan = vi.fn(async () => (++n > 1 ? found(2, 0) : found(0, 0)))
    const first = scanAllProjects([{ id: 'p1' }], () => true, scan)
    await scanAllProjects([{ id: 'p1' }, { id: 'p2' }], () => true, scan)
    await first
    expect(getResumeScan().rows).toHaveLength(1)
    await rescanProject('p1', scan)
    expect(rowEngines(getResumeScan().rows[0])).toEqual(['claude'])
    // 没扫过的项目、远程项目不重扫
    await rescanProject('nope', scan)
    expect(scan).toHaveBeenCalledTimes(2)
  })
})

describe('scanView', () => {
  const row = (projectId: string, state: ScanRow['state'], result: ProjectScan | null = null): ScanRow => ({
    projectId,
    state,
    result,
  })
  const rows = [
    row('a', 'done', found(3, 5)),
    row('b', 'done', found(0, 0)),
    row('c', 'scanning'),
    row('d', 'waiting'),
    row('r', 'remote'),
  ]

  it('只看有会话的：留下有会话的和在扫的，数出藏起来的', () => {
    const v = scanView({ rows, running: true }, true)
    expect(v.rows.map(r => r.projectId)).toEqual(['a', 'c'])
    expect(v).toMatchObject({ done: 2, total: 4, found: 1, hiddenNone: 1, hiddenRemote: 1, hiddenSkipped: 0 })
    // 停下以后排队的算「没扫」
    expect(scanView({ rows, running: false }, true).hiddenSkipped).toBe(1)
  })

  it('显示全部：所有行都在，不算藏起来的', () => {
    const v = scanView({ rows, running: false }, false)
    expect(v.rows).toHaveLength(5)
    expect(v.hiddenNone + v.hiddenRemote + v.hiddenSkipped).toBe(0)
  })

  it('rowLatest 取两个引擎里最晚的', () => {
    expect(rowLatest(row('a', 'done', found(3, 5, 1000)))).toBe(1001)
    expect(rowLatest(row('b', 'done', found(0, 0)))).toBeNull()
  })
})
