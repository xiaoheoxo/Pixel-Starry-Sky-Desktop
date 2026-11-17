// 内存遥测（docs/ui/renderer-memory.md §3.2、§4.1）
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] } }))
vi.mock('@pixelsky/engine', () => ({
  logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import {
  bandOf,
  createLowMemory,
  createTelemetry,
  HEARTBEAT_MS,
  LOW_MEMORY_COOLDOWN_MS,
  parseRendererSample,
  rendererBasis,
  sampleFields,
  summarizeProcesses,
  systemMemory,
  type MemorySample,
} from './memory'

const KB = 1024
const renderer = (
  over: Partial<NonNullable<MemorySample['renderer']>> = {},
): NonNullable<MemorySample['renderer']> => ({
  heapUsedMb: 80,
  heapTotalMb: 100,
  heapLimitMb: 3586,
  elements: 3000,
  mountedTabs: 3,
  sessionViews: 2,
  shownTurnsMax: 20,
  snapshots: 3,
  snapshotItems: 500,
  snapshotTextMb: 4,
  imageB64Mb: 0,
  terminals: 1,
  terminalLines: 100,
  codeEditors: 0,
  lightweight: false,
  ...over,
})
interface Over {
  privateMb?: number | null
  gpuMb?: number
  heap?: number
  els?: number
  snapMb?: number
  freePct?: number
  commitPct?: number
  renderer?: null
}
function sample(at: number, o: Over = {}): MemorySample {
  const privateMb = o.privateMb === null ? undefined : (o.privateMb ?? 300)
  return {
    at,
    renderer:
      o.renderer === null
        ? null
        : renderer({ heapUsedMb: o.heap ?? 80, elements: o.els ?? 3000, snapshotTextMb: o.snapMb ?? 4 }),
    processes: {
      renderer: { workingSetMb: (privateMb ?? 400) + 100, ...(privateMb !== undefined ? { privateMb } : {}) },
      ...(o.gpuMb !== undefined ? { gpu: { privateMb: o.gpuMb, workingSetMb: o.gpuMb } } : {}),
      otherMb: 0,
    },
    system: {
      totalMb: 32000,
      freeMb: 8000,
      freePct: o.freePct ?? 50,
      ...(o.commitPct !== undefined ? { commitTotalMb: 38000, commitFreeMb: 10000, commitFreePct: o.commitPct } : {}),
    },
    main: { heapUsedMb: 50, rssMb: 200 },
    engine: { runtimes: 1, processes: 0, running: 0 },
  }
}
const MIN = 60_000

describe('bandOf：档位和回差', () => {
  it('界面私有内存：512 MB、1 GB，之后每 512 MB 一档', () => {
    const level = (v: number) => bandOf('private', v, 0)
    expect([300, 576, 1088, 1600, 2112].map(level)).toEqual([0, 1, 2, 3, 4])
  })

  it('JS 堆在 256 MB 边界上下 20 MB 来回不换档', () => {
    let level = 0
    for (const v of [240, 276, 236, 270, 250]) {
      level = bandOf('heap', v, level)
      expect(level).toBe(0)
    }
    level = bandOf('heap', 300, level)
    expect(level).toBe(1)
    for (const v of [276, 236, 260]) {
      level = bandOf('heap', v, level)
      expect(level).toBe(1)
    }
    expect(bandOf('heap', 200, level)).toBe(0)
  })

  it('元素数：1 万、2.5 万、5 万，回差 1000', () => {
    expect([9_500, 11_000, 26_000, 51_000].map(v => bandOf('elements', v, 0))).toEqual([0, 1, 2, 3])
    expect(bandOf('elements', 9_500, 1)).toBe(1)
    expect(bandOf('elements', 8_900, 1)).toBe(0)
  })

  it('快照规模每 64 MB 一档，回差 8 MB', () => {
    expect(bandOf('snapshot', 60, 0)).toBe(0)
    expect(bandOf('snapshot', 72, 0)).toBe(1)
    expect(bandOf('snapshot', 60, 1)).toBe(1)
    expect(bandOf('snapshot', 55, 1)).toBe(0)
  })

  it('整机余量：越低档越高，回差 1 个百分点', () => {
    expect([30, 19, 9, 4].map(v => bandOf('free', v, 0))).toEqual([0, 1, 2, 3])
    expect(bandOf('free', 20, 0)).toBe(0)
    expect(bandOf('free', 20, 1)).toBe(1)
    expect(bandOf('free', 22, 1)).toBe(0)
  })
})

describe('写盘规则', () => {
  it('首条一定写；之后没换档不写；加载后的第一条再写', () => {
    const t = createTelemetry()
    expect(t.push(sample(0), 0).write).toBe(true)
    expect(t.push(sample(MIN), MIN).write).toBe(false)
    t.markLoaded()
    expect(t.push(sample(2 * MIN), 2 * MIN).write).toBe(true)
  })

  it('换档超过 60 秒才写；JS 堆升档不突破限速，攒到 60 秒', () => {
    const t = createTelemetry()
    t.push(sample(0), 0)
    expect(t.push(sample(10_000, { heap: 400 }), 10_000).write).toBe(false)
    expect(t.push(sample(30_000, { heap: 400 }), 30_000).write).toBe(false)
    expect(t.push(sample(60_000, { heap: 400 }), 60_000).write).toBe(true)
    expect(t.push(sample(70_000, { heap: 400 }), 70_000).write).toBe(false)
  })

  it('界面私有内存升档、整机余量降档可以突破限速', () => {
    const t = createTelemetry()
    t.push(sample(0), 0)
    expect(t.push(sample(1000, { privateMb: 700 }), 1000).write).toBe(true)
    expect(t.push(sample(2000, { privateMb: 700, freePct: 8 }), 2000).write).toBe(true)
    expect(t.push(sample(3000, { privateMb: 700, freePct: 8, commitPct: 4 }), 3000).write).toBe(true)
  })

  it('GPU、元素数、快照换档不突破限速', () => {
    const t = createTelemetry()
    t.push(sample(0), 0)
    expect(t.push(sample(1000, { gpuMb: 700 }), 1000).write).toBe(false)
    expect(t.push(sample(2000, { gpuMb: 700, els: 30_000 }), 2000).write).toBe(false)
    expect(t.push(sample(3000, { gpuMb: 700, els: 30_000, snapMb: 100 }), 3000).write).toBe(false)
  })

  it('往好的方向换档不突破限速', () => {
    const t = createTelemetry()
    t.push(sample(0, { privateMb: 700 }), 0)
    expect(t.push(sample(1000, { privateMb: 200 }), 1000).write).toBe(false)
  })

  it('30 分钟心跳', () => {
    const t = createTelemetry()
    t.push(sample(0), 0)
    expect(t.push(sample(HEARTBEAT_MS - 1), HEARTBEAT_MS - 1).write).toBe(false)
    expect(t.push(sample(HEARTBEAT_MS), HEARTBEAT_MS).write).toBe(true)
  })

  it('没有 privateMb（macOS）时按工作集判断', () => {
    const s = sample(0, { privateMb: null })
    expect(rendererBasis(s.processes.renderer)).toEqual({ mb: 500, basis: 'ws' })
    expect(sampleFields(s).basis).toBe('ws')
    expect(sampleFields(sample(0))).not.toHaveProperty('basis')
    const t = createTelemetry()
    t.push(sample(0, { privateMb: null }), 0)
    const big = sample(1000, { privateMb: null })
    big.processes.renderer = { workingSetMb: 1200 }
    expect(t.push(big, 1000)).toMatchObject({ write: true, intervalMs: 10_000 })
  })
})

describe('快采', () => {
  it('私有内存 ≥ 1024 MB 进入，回落到 896 MB 以下且余量 ≥ 12% 才退出', () => {
    const t = createTelemetry()
    expect(t.push(sample(0), 0)).toMatchObject({ intervalMs: 60_000, level: 'info' })
    expect(t.push(sample(1, { privateMb: 1100 }), 1)).toMatchObject({ intervalMs: 10_000, level: 'warn' })
    // 进入时那一条才 warn
    expect(t.push(sample(2, { privateMb: 1000 }), 2)).toMatchObject({ intervalMs: 10_000, level: 'info' })
    expect(t.push(sample(3, { privateMb: 900 }), 3).intervalMs).toBe(10_000)
    expect(t.push(sample(4, { privateMb: 800, freePct: 11 }), 4).intervalMs).toBe(10_000)
    expect(t.push(sample(5, { privateMb: 800, freePct: 12, commitPct: 11 }), 5).intervalMs).toBe(10_000)
    expect(t.push(sample(6, { privateMb: 800, freePct: 12, commitPct: 12 }), 6).intervalMs).toBe(60_000)
  })

  it('整机物理或可提交余量 < 10% 进入快采并用 warn', () => {
    const t = createTelemetry()
    expect(t.push(sample(0, { freePct: 9 }), 0)).toMatchObject({ intervalMs: 10_000, level: 'warn' })
    const c = createTelemetry()
    expect(c.push(sample(0, { commitPct: 9 }), 0)).toMatchObject({ intervalMs: 10_000, level: 'warn' })
  })
})

describe('环和崩溃字段', () => {
  it('只留最近 10 条，界面没报时 renderer 为 null', () => {
    const t = createTelemetry()
    for (let i = 0; i < 15; i++) t.push(sample(i, i === 14 ? { renderer: null } : {}), i)
    const recent = t.recent()
    expect(recent).toHaveLength(10)
    expect(recent[0].at).toBe(5)
    expect(sampleFields(recent[9]).renderer).toBeNull()
    expect(t.recent(3).map(s => s.at)).toEqual([12, 13, 14])
  })
})

describe('取数', () => {
  it('commit 直接取 swapTotal / swapFree，不再加物理内存', () => {
    const info = { total: 33_074_804, free: 8_000_000, swapTotal: 38_055_540, swapFree: 16_561_656 }
    const s = systemMemory(info, 'win32')
    expect(s.commitTotalMb).toBe(Math.round(38_055_540 / KB))
    expect(s.commitFreeMb).toBe(Math.round(16_561_656 / KB))
    expect(s.commitFreePct).toBe(44)
    expect(s.freePct).toBe(24)
  })

  it('Linux、macOS 不取 commit', () => {
    const info = { total: 1000 * KB, free: 500 * KB, swapTotal: 100 * KB, swapFree: 50 * KB }
    expect(systemMemory(info, 'linux').commitFreePct).toBeUndefined()
    expect(systemMemory({ total: 1000 * KB, free: 500 * KB }, 'darwin').commitFreePct).toBeUndefined()
  })

  it('各进程：界面按 pid 找，其余合计（有私有用私有，没有用工作集）', () => {
    const m = (pid: number, type: string, ws: number, priv?: number) => ({
      pid,
      type,
      memory: { workingSetSize: ws * KB, ...(priv !== undefined ? { privateBytes: priv * KB } : {}) },
    })
    const out = summarizeProcesses(
      [
        m(1, 'Browser', 300, 250),
        m(2, 'Tab', 1200, 1000),
        m(3, 'GPU', 600, 400),
        m(4, 'Utility', 100, 80),
        m(5, 'Tab', 90),
      ],
      2,
    )
    expect(out).toEqual({
      browser: { workingSetMb: 300, privateMb: 250 },
      renderer: { workingSetMb: 1200, privateMb: 1000 },
      gpu: { workingSetMb: 600, privateMb: 400 },
      otherMb: 170,
    })
  })

  it('界面传来的数不可信：非数字、负数当 0', () => {
    const parsed = parseRendererSample({ heapUsedMb: 12.34, elements: -1, mountedTabs: 'x', lightweight: 1 })
    expect(parsed).toMatchObject({ heapUsedMb: 12.3, elements: 0, mountedTabs: 0, lightweight: false })
    expect(parseRendererSample(null)).toBeNull()
  })
})

describe('内存紧张时释放闲置引擎进程（docs/engine-idle-release.md §3 #2）', () => {
  const sys = (freePct: number, commitFreePct?: number) => ({
    totalMb: 16000,
    freeMb: 160 * freePct,
    freePct,
    ...(commitFreePct !== undefined ? { commitTotalMb: 20000, commitFreeMb: 200 * commitFreePct, commitFreePct } : {}),
  })

  it('物理可用低于 15% 进入，马上放一次；两项都回到 18% 才退出', () => {
    const lm = createLowMemory('linux')
    expect(lm.push(sys(40), 0)).toEqual({ release: false, changed: null })
    expect(lm.push(sys(14), 1000)).toEqual({ release: true, changed: 'enter' })
    expect(lm.low).toBe(true)
    // 回到 16%：还在回差里，不退出；离上次释放不到 60 秒，不再放
    expect(lm.push(sys(16), 2000)).toEqual({ release: false, changed: null })
    expect(lm.push(sys(18), 3000)).toEqual({ release: false, changed: 'exit' })
    expect(lm.low).toBe(false)
  })

  it('一直紧张时每 60 秒放一次', () => {
    const lm = createLowMemory('linux')
    lm.push(sys(10), 0)
    expect(lm.push(sys(10), LOW_MEMORY_COOLDOWN_MS - 1).release).toBe(false)
    expect(lm.push(sys(10), LOW_MEMORY_COOLDOWN_MS).release).toBe(true)
    expect(lm.push(sys(10), LOW_MEMORY_COOLDOWN_MS + 10_000).release).toBe(false)
  })

  it('Windows 看可提交余量：物理够、提交不够也算紧张；退出要两项都够', () => {
    const lm = createLowMemory('win32')
    expect(lm.push(sys(50, 12), 0)).toEqual({ release: true, changed: 'enter' })
    expect(lm.push(sys(50, 17), 1000).changed).toBeNull()
    expect(lm.push(sys(17, 30), 2000).changed).toBeNull()
    expect(lm.push(sys(30, 30), 3000).changed).toBe('exit')
  })

  it('macOS 物理可用口径偏低，5% 才算紧张、8% 退出', () => {
    const lm = createLowMemory('darwin')
    expect(lm.push(sys(10), 0).changed).toBeNull()
    expect(lm.push(sys(4), 1000)).toEqual({ release: true, changed: 'enter' })
    expect(lm.push(sys(8), 2000).changed).toBe('exit')
  })

  it('退出后又马上紧张：进入时照样马上放，不受冷却限制', () => {
    const lm = createLowMemory('linux')
    lm.push(sys(10), 0)
    lm.push(sys(30), 1000)
    expect(lm.push(sys(10), 2000)).toEqual({ release: true, changed: 'enter' })
  })
})

describe('Linux 的物理可用按 MemAvailable 算', () => {
  it('available 有值时用它；老内核上是 0 时退回 free；别的平台不看它', () => {
    const KB = 1024
    const info = { total: 1000 * KB, free: 50 * KB, available: 600 * KB }
    expect(systemMemory(info, 'linux')).toMatchObject({ freeMb: 600, freePct: 60 })
    expect(systemMemory({ ...info, available: 0 }, 'linux')).toMatchObject({ freeMb: 50, freePct: 5 })
    expect(systemMemory(info, 'win32').freePct).toBe(5)
  })
})

describe('界面内存分项（docs/memory-tier2.md §2）', () => {
  it('parseRendererSample：分项只留合法的数，一项都不合法或不是对象就没有', () => {
    const parsed = parseRendererSample({
      ...renderer(),
      native: { v8UsedMb: 65.04, blinkAllocMb: -1, cacheImagesMb: 'x', extra: 9 },
    })
    expect(parsed?.native).toEqual({ v8UsedMb: 65 })
    expect(parseRendererSample({ ...renderer(), native: { v8UsedMb: Number.NaN } })?.native).toBeUndefined()
    expect(parseRendererSample({ ...renderer(), native: 'x' })).not.toHaveProperty('native')
  })

  it('sampleFields：分项平铺在 renderer 里，没有的不写', () => {
    const s = sample(0)
    s.renderer = renderer({
      native: { v8UsedMb: 65, v8TotalMb: 80, v8CodeMb: 5, blinkAllocMb: 120, blinkTotalMb: 180, cacheImagesMb: 30 },
    })
    const r = sampleFields(s).renderer as Record<string, unknown>
    expect(r).toMatchObject({ v8: '65/80', code: 5, blink: '120/180', img: 30 })
    expect(r).not.toHaveProperty('font')
    expect(Object.values(r).some(v => v !== null && typeof v === 'object')).toBe(false)
    expect(sampleFields(sample(0)).renderer).not.toHaveProperty('v8')
  })

  it('只有分项不同的两条采样不多写一次盘', () => {
    const t = createTelemetry()
    expect(t.push(sample(0), 0).write).toBe(true)
    const next = sample(MIN)
    next.renderer = renderer({ native: { v8UsedMb: 500, blinkAllocMb: 400 } })
    expect(t.push(next, MIN).write).toBe(false)
  })
})
