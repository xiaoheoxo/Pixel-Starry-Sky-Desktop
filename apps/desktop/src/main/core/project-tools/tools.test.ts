import { describe, expect, it, vi } from 'vitest'
import type { EngineHost } from '@pixelsky/engine'
import type { Item, SessionRecord } from '@pixelsky/protocol'
import { createToolsHost } from './tools'

const todo = (id: string): Extract<Item, { kind: 'todo' }> => ({
  kind: 'todo',
  id,
  steps: [{ text: id, status: 'pending' }],
  status: 'completed',
})
const session = (id: string, projectId: string, archivedAt: number | null = null) => ({
  record: { id, title: `标题 ${id}`, projectId, archivedAt } as SessionRecord,
  state: 'idle',
})

describe('createToolsHost.plans', () => {
  it('只取项目里没归档会话的最后一个 todo，不调 host.open（不建运行时）', async () => {
    const open = vi.fn()
    const lastTodo = vi.fn(async (id: string) =>
      id === 'none' ? null : id === 'broken' ? Promise.reject(new Error('x')) : todo(`t-${id}`),
    )
    const host = {
      sessions: () => [
        session('a', 'p'),
        session('none', 'p'),
        session('broken', 'p'),
        session('old', 'p', 1),
        session('b', 'q'),
      ],
      open,
      lastTodo,
    } as unknown as EngineHost
    const tools = createToolsHost({
      host: () => host,
      resolve: () => ({ name: 'n', path: '/p' }) as never,
      record: () => null,
    })
    const plans = await tools.plans('p')
    expect(plans.map(p => [p.sessionId, p.title, p.item.id])).toEqual([['a', '标题 a', 't-a']])
    expect(open).not.toHaveBeenCalled()
    expect(lastTodo.mock.calls.map(c => c[0])).toEqual(['a', 'none', 'broken'])
  })

  function toolsOf(host: unknown) {
    return createToolsHost({
      host: () => host as EngineHost,
      resolve: () => ({ name: 'n', path: '/p' }) as never,
      record: () => null,
    })
  }

  it('一次最多同时读 4 个会话', async () => {
    let active = 0,
      peak = 0
    const host = {
      sessions: () => Array.from({ length: 11 }, (_, i) => session(`s${i}`, 'p')),
      lastTodo: async (id: string) => {
        peak = Math.max(peak, ++active)
        await new Promise(r => setTimeout(r, 5))
        active--
        return todo(`t-${id}`)
      },
    }
    const plans = await toolsOf(host).plans('p')
    expect(plans.map(p => p.sessionId)).toEqual(Array.from({ length: 11 }, (_, i) => `s${i}`))
    expect(peak).toBe(4)
  })

  it('同一个项目读的过程中又来的请求合成接着的一次：不并行、也不拿读之前的旧结果', async () => {
    let version = 'v1',
      running = 0,
      overlapped = false
    const gates: Array<() => void> = []
    const host = {
      sessions: () => [session('a', 'p')],
      lastTodo: async () => {
        if (++running > 1) overlapped = true
        const seen = version
        await new Promise<void>(r => gates.push(r))
        running--
        return todo(seen)
      },
    }
    const tools = toolsOf(host)
    const first = tools.plans('p')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    version = 'v2'
    // 读的过程中来了三次请求：合成一次，排在第一次之后
    const later = [tools.plans('p'), tools.plans('p'), tools.plans('p')]
    gates.shift()!()
    expect((await first)[0].item.id).toBe('v1')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    gates.shift()!()
    const results = await Promise.all(later)
    expect(results.map(r => r[0].item.id)).toEqual(['v2', 'v2', 'v2'])
    expect(overlapped).toBe(false)
    // 都结束后再来的请求重新读
    version = 'v3'
    const again = tools.plans('p')
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    gates.shift()!()
    expect((await again)[0].item.id).toBe('v3')
  })

  it('不同项目互不等待；前一次失败不影响排队的那次', async () => {
    let fail = true
    const host = {
      sessions: () => [session('a', 'p'), session('b', 'q')],
      lastTodo: async (id: string) => {
        await new Promise(r => setTimeout(r, 5))
        if (fail && id === 'a') throw new Error('x')
        return todo(`t-${id}`)
      },
    }
    const tools = toolsOf(host)
    const [p, q] = await Promise.all([tools.plans('p'), tools.plans('q')])
    expect([p.length, q.length]).toEqual([0, 1])
    fail = false
    const [first, second] = [tools.plans('p'), tools.plans('p')]
    expect((await Promise.all([first, second])).map(r => r.length)).toEqual([1, 1])
  })

  it('引擎还没就绪时是空列表', async () => {
    const tools = createToolsHost({
      host: () => null,
      resolve: () => ({ name: 'n', path: '/p' }) as never,
      record: () => null,
    })
    expect(await tools.plans('p')).toEqual([])
  })
})
