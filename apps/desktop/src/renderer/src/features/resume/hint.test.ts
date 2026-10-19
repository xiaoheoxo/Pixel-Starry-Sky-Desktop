// 导入项目后的「这个项目有会话，接着聊」提示：文案、查询失败、并发限制、打开选择器
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { EngineConfig, NativeSessionSummary } from '@pixelsky/protocol'
import {
  HINT_MAX_PROJECTS,
  fetchResumeCounts,
  hintEngine,
  hintMessage,
  cachedResumeCounts,
  cachedResumeHint,
  ensureResumeCounts,
  refreshResumeCounts,
  hintText,
  mapLimit,
  noteEngineConfig,
  openResumeFor,
  prefetchResumeCounts,
  resetResumeHints,
  resumableCount,
} from './hint'
import { closeResumePicker } from './store'
import * as store from './store'

const session = (id: string, ownerId: string | null = null): NativeSessionSummary =>
  ({ id, ownerId }) as unknown as NativeSessionSummary
const sessions = (n: number): NativeSessionSummary[] => Array.from({ length: n }, (_, i) => session(`s${i}`))

describe('hintMessage / hintText', () => {
  it('0 个或没有：不提示', () => {
    expect(hintMessage({})).toBeNull()
    expect(hintMessage({ claude: 0, codex: 0 })).toBeNull()
    expect(hintText({})).toBeNull()
  })
  it('只有一个引擎', () => {
    expect(hintMessage({ claude: 3 })).toEqual({ key: 'resume.hint.claude', params: { n: 3 } })
    expect(hintMessage({ claude: 0, codex: 2 })).toEqual({ key: 'resume.hint.codex', params: { n: 2 } })
    expect(hintText({ claude: 1 })).toBe('这个项目有 1 个 Claude Code 会话可以接着聊')
  })
  it('两个引擎都有', () => {
    expect(hintMessage({ claude: 3, codex: 2 })).toEqual({ key: 'resume.hint.both', params: { claude: 3, codex: 2 } })
    expect(hintText({ claude: 3, codex: 2 })).toBe('这个项目有 3 个 Claude Code、2 个 Codex 会话可以接着聊')
  })
})

describe('fetchResumeCounts', () => {
  it('已被像素星空占用的不算', () => {
    expect(resumableCount([session('a'), session('b', 'conv')])).toBe(1)
  })
  it('按引擎数', async () => {
    const list = vi.fn(async (_p: string, engine: string) => (engine === 'claude' ? sessions(3) : sessions(2)))
    expect(await fetchResumeCounts('p1', list, ['claude', 'codex'])).toEqual({ claude: 3, codex: 2 })
  })
  it('默认两个引擎都查', async () => {
    const list = vi.fn(async (_p: string, engine: string) => (engine === 'claude' ? sessions(1) : sessions(4)))
    expect(await fetchResumeCounts('p1', list)).toEqual({ claude: 1, codex: 4 })
    expect(list.mock.calls.map(c => c[1]).sort()).toEqual(['claude', 'codex'])
  })
  it('Codex 的会话已被像素星空占用的不算', async () => {
    const list = async (_p: string, engine: string) =>
      engine === 'codex' ? [session('a'), session('b', 'conv'), session('c', 'conv')] : []
    expect(await fetchResumeCounts('p1', list)).toEqual({ codex: 1 })
  })
  it('Codex 查询抛错（没装）当 0：Claude 的数量照常，只有 Codex 时不提示', async () => {
    const list = async (_p: string, engine: string) => {
      if (engine === 'codex') throw new Error('Codex 没装好，读不到它的会话')
      return sessions(2)
    }
    const counts = await fetchResumeCounts('p1', list)
    expect(counts).toEqual({ claude: 2 })
    expect(hintText(counts)).toBe('这个项目有 2 个 Claude Code 会话可以接着聊')
    const onlyCodex = await fetchResumeCounts('p1', async () => Promise.reject(new Error('x')))
    expect(onlyCodex).toEqual({})
    expect(hintMessage(onlyCodex)).toBeNull()
  })
  it('只有 Codex 有会话：文案和打开的引擎都是 Codex', async () => {
    const counts = await fetchResumeCounts('p1', async (_p, engine) => (engine === 'codex' ? sessions(3) : []))
    expect(hintText(counts)).toBe('这个项目有 3 个 Codex 会话可以接着聊')
    expect(hintEngine(counts)).toBe('codex')
  })
  it('两个引擎都有：用「both」文案，点「接着聊」先开当前执行者的，执行者都不是开会话多的', async () => {
    const counts = await fetchResumeCounts('p1', async (_p, engine) =>
      engine === 'claude' ? sessions(3) : sessions(2),
    )
    expect(hintText(counts)).toBe('这个项目有 3 个 Claude Code、2 个 Codex 会话可以接着聊')
    expect(hintEngine(counts)).toBe('claude')
    expect(hintEngine(counts, 'codex')).toBe('codex')
    expect(hintEngine(counts, 'claude')).toBe('claude')
    expect(hintEngine(counts, 'pixel')).toBe('claude')
    expect(hintEngine({ claude: 1, codex: 4 }, 'pixel')).toBe('codex')
    expect(hintEngine({ claude: 1, codex: 4 }, null)).toBe('codex')
    expect(hintEngine({ claude: 2, codex: 2 })).toBe('claude')
    // 只有一个引擎有会话时，执行者是谁都开那一个
    expect(hintEngine({ codex: 1 }, 'claude')).toBe('codex')
  })
  it('查询失败 / 不支持：当没有，不抛错', async () => {
    const list = vi.fn(async (_p: string, engine: string) => {
      if (engine === 'codex') throw new Error('不支持')
      return sessions(1)
    })
    expect(await fetchResumeCounts('p1', list, ['claude', 'codex'])).toEqual({ claude: 1 })
    expect(await fetchResumeCounts('p1', async () => Promise.reject(new Error('x')))).toEqual({})
  })
  it('远程机器 / WSL 项目不查', async () => {
    const list = vi.fn(async () => sessions(2))
    expect(await fetchResumeCounts('ssh-abc123~p', list)).toEqual({})
    expect(await fetchResumeCounts('wsl-abc123~p', list)).toEqual({})
    expect(list).not.toHaveBeenCalled()
  })
})

describe('并发限制', () => {
  it('mapLimit 同时最多 limit 个，结果按原顺序', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async n => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 2))
      running--
      return n * 2
    })
    expect(peak).toBe(4)
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
  })
  it('两个引擎同时查：一个项目的两次查询并行（不比只查一个慢），总数仍不超过上限', async () => {
    let running = 0
    let peak = 0
    const list = vi.fn(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 5))
      running--
      return []
    })
    await fetchResumeCounts('solo', list)
    expect(peak).toBe(2)
    peak = 0
    resetResumeHints(list)
    await prefetchResumeCounts(Array.from({ length: 12 }, (_, i) => `q${i}`))
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
    resetResumeHints()
  })
  it('prefetchResumeCounts 限制并发、只查前若干个、同一项目只查一次', async () => {
    let running = 0
    let peak = 0
    const list = vi.fn(async (p: string) => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 1))
      running--
      return p === 'p0' ? sessions(2) : []
    })
    resetResumeHints(list)
    const ids = Array.from({ length: HINT_MAX_PROJECTS + 20 }, (_, i) => `p${i}`)
    const found = await prefetchResumeCounts([...ids, 'p0'])
    expect(peak).toBeLessThanOrEqual(4)
    // 每个项目查两个引擎
    expect(list).toHaveBeenCalledTimes(HINT_MAX_PROJECTS * 2)
    expect([...found.keys()]).toEqual(['p0'])
    expect(found.get('p0')).toEqual({ claude: 2, codex: 2 })
    await prefetchResumeCounts(['p0'])
    expect(list).toHaveBeenCalledTimes(HINT_MAX_PROJECTS * 2)
    resetResumeHints()
  })
})

describe('引擎启动配置变了', () => {
  const config = (codexHome: string, args: string[] = []): EngineConfig =>
    ({
      claude: { path: null, args: [], env: {} },
      codex: { path: null, args, env: { CODEX_HOME: codexHome } },
    }) as unknown as EngineConfig
  const flush = (): Promise<void> => new Promise(r => setTimeout(r, 5))

  it('改了 CODEX_HOME / 参数：缓存作废、按新目录重查；内容一样的新配置不重查', async () => {
    let home = 'A'
    const list = vi.fn(async (_p: string, engine: string) => (engine === 'codex' ? sessions(home === 'A' ? 1 : 3) : []))
    resetResumeHints(list)
    noteEngineConfig(config('A'))
    await ensureResumeCounts('p')
    expect(cachedResumeCounts('p')).toEqual({ codex: 1 })
    expect(list).toHaveBeenCalledTimes(2)

    // 新对象、内容一样（引擎设置里改了别的）：不重查
    noteEngineConfig(config('A'))
    await flush()
    expect(list).toHaveBeenCalledTimes(2)

    home = 'B'
    noteEngineConfig(config('B'))
    await flush()
    expect(cachedResumeCounts('p')).toEqual({ codex: 3 })
    expect(list).toHaveBeenCalledTimes(4)

    noteEngineConfig(config('B', ['-c', 'x=1']))
    await flush()
    expect(list).toHaveBeenCalledTimes(6)
    resetResumeHints()
  })

  it('查的途中配置变了：旧结果丢掉，等着的人拿到新目录的结果', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    let home = 'A'
    const list = vi.fn(async (_p: string, engine: string) => {
      const at = home
      if (at === 'A') await gate
      return engine === 'codex' ? sessions(at === 'A' ? 1 : 3) : []
    })
    resetResumeHints(list)
    noteEngineConfig(config('A'))
    const first = ensureResumeCounts('p')
    home = 'B'
    noteEngineConfig(config('B'))
    release()
    await first
    expect(cachedResumeCounts('p')).toEqual({ codex: 3 })
    resetResumeHints()
  })
})

describe('失败原因和手动重新查找', () => {
  it('查失败的引擎记下原因；有失败时缓存不算新鲜，下次照样重查', async () => {
    let fail = true
    const list = vi.fn(async (_p: string, engine: string) => {
      if (engine === 'codex' && fail) throw new Error('读取超时')
      return engine === 'claude' ? [] : sessions(2)
    })
    resetResumeHints(list)
    await ensureResumeCounts('q')
    expect(cachedResumeHint('q')).toEqual({ counts: {}, errors: { codex: '读取超时' }, checking: false })
    fail = false
    await ensureResumeCounts('q')
    expect(list).toHaveBeenCalledTimes(4)
    expect(cachedResumeHint('q')).toEqual({ counts: { codex: 2 }, errors: {}, checking: false })
    resetResumeHints()
  })
  it('没失败时一分钟内不重查；refreshResumeCounts 不管缓存马上重查，查的时候 checking 为 true', async () => {
    const list = vi.fn(async () => sessions(1))
    resetResumeHints(list)
    await ensureResumeCounts('r')
    await ensureResumeCounts('r')
    expect(list).toHaveBeenCalledTimes(2)
    const again = refreshResumeCounts('r')
    expect(cachedResumeHint('r')).toMatchObject({ counts: { claude: 1, codex: 1 }, checking: true })
    await again
    expect(list).toHaveBeenCalledTimes(4)
    expect(cachedResumeHint('r')).toEqual({ counts: { claude: 1, codex: 1 }, errors: {}, checking: false })
    resetResumeHints()
  })
})

describe('openResumeFor', () => {
  it('直接打开该项目、该引擎的选择器，不靠输入 /resume', () => {
    const spy = vi.spyOn(store, 'openResumePicker')
    openResumeFor('p1', 'claude')
    openResumeFor('p2', 'codex')
    openResumeFor('p3')
    expect(spy.mock.calls.map(c => [c[0].projectId, c[0].engine])).toEqual([
      ['p1', 'claude'],
      ['p2', 'codex'],
      ['p3', 'claude'],
    ])
    closeResumePicker()
    spy.mockRestore()
  })
})
