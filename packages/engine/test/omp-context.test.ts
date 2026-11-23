import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineHost } from '../src'
import { OmpAdapter } from '../src/omp'
import { ompContext } from '../src/omp/context'
import { makeTmp, removeTmp } from './helpers/tmp'

// oh-my-pi 的上下文明细（docs/omp-engine.md §15）

const FAKE = fileURLToPath(new URL('./fakes/fake-omp.mjs', import.meta.url))
let root: string, host: EngineHost | undefined
beforeEach(() => {
  root = makeTmp('omp-context')
})
afterEach(async () => {
  await host?.shutdown()
  host = undefined
  removeTmp(root)
})
const wait = async (fn: () => boolean): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('omp context test timed out')
}
function setup(context: string): { id: string; asked: () => number } {
  const log = join(root, 'rpc.jsonl')
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC|OPENAI|PIXELSKY)_/i.test(k)))
  const adapter = new OmpAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    env: { ...env, FAKE_OMP_LOG: log, FAKE_OMP_DIR: join(root, 'sessions'), FAKE_OMP_CONTEXT: context },
    dataDir: join(root, 'engine'),
  })
  host = new EngineHost({ dataDir: join(root, 'engine'), adapters: { omp: adapter }, emit: () => {}, idleMs: 10_000 })
  const { id } = host.createSession({
    projectId: host.addProject(root).id,
    engine: 'omp',
    model: 'fake/fake-omp',
    permissionMode: 'ask',
  })
  const asked = (): number =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(l => l.includes('"/context"')).length
      : 0
  return { id, asked }
}
const snap = (id: string) => host!.open(id)
const idle = (id: string): boolean => snap(id).state === 'idle'
const notices = (id: string): string[] => snap(id).items.flatMap(i => (i.kind === 'notice' ? [i.text] : []))

describe('oh-my-pi 上下文明细', () => {
  it('每轮结束自动取：分类进明细，不进对话', async () => {
    const { id } = setup('1')
    await host!.send(id, '你好')
    await wait(() => idle(id) && snap(id).context?.diagnosticStale === false)
    expect(snap(id).flags.contextLive).toBe(true)
    expect(snap(id).context!.diagnostic).toMatchObject({ window: 200000, tools: [], memory: [] })
    expect(snap(id).context!.diagnostic!.categories).toContainEqual({
      name: 'Instruction files',
      tokens: 3207,
      kind: 'used',
    })
    expect(notices(id)).toEqual([])
    expect(snap(id).items.filter(i => i.kind === 'user')).toHaveLength(1)
  })

  it('运行中也能刷新，这一轮照常做完', async () => {
    const { id } = setup('1')
    await host!.send(id, '工具')
    await wait(() => snap(id).pending.length === 1 && snap(id).flags.contextLive === true)
    const d = await host!.inspectContext(id, 'summary')
    expect(d.categories).toHaveLength(8)
    expect(idle(id)).toBe(false)
    host!.answer(id, snap(id).pending[0].requestId, { type: 'allow' })
    await wait(() => idle(id))
    expect(notices(id)).toEqual([])
  })

  it('取的时候夹着别的内置命令的输出：照常显示，不吞掉', async () => {
    const { id } = setup('mixed')
    await host!.send(id, '你好')
    await wait(() => idle(id) && snap(id).context?.diagnosticStale === false)
    expect(new Set(notices(id))).toEqual(new Set(['别的输出']))
  })

  it('认不出格式：只试一次，不显示到对话里，刷新报没有', async () => {
    const { id, asked } = setup('bad')
    for (const text of ['你好', '再来']) {
      await host!.send(id, text)
      await wait(() => idle(id))
    }
    expect(asked()).toBe(1)
    expect(notices(id)).toEqual([])
    expect(snap(id).flags.contextLive ?? false).toBe(false)
    await expect(host!.inspectContext(id)).rejects.toThrow()
  })

  it('没有自带的 /context：不发（会被当成消息发给模型）', async () => {
    const { id, asked } = setup('')
    await host!.send(id, '你好')
    await wait(() => idle(id))
    expect(asked()).toBe(0)
  })
})

describe('ompContext', () => {
  it('预留、剩余分开；没给占用时按窗口减去它们；不认识的行不管', () => {
    const text = [
      'Context window: 1000 tokens (30% used)',
      '  New kind  [██] 30%  300 tokens',
      '  Auto-compact buf [█] 10%  100 tokens',
      '  Free [██] 60%  600 tokens',
      '  System prompt: 5 text tokens → 1 frame',
    ].join('\n')
    const d = ompContext(text, 'm', null, 1)
    expect(d).toMatchObject({ used: 300, window: 1000, observedAt: 1 })
    expect(d!.categories).toEqual([
      { name: 'New kind', tokens: 300, kind: 'used' },
      { name: 'Autocompact buffer', tokens: 100, kind: 'buffer' },
      { name: 'Free space', tokens: 600, kind: 'free' },
    ])
    expect(ompContext('Context\nWindow: 1000\nUsed: 3', 'm', 3)).toBeNull()
    expect(ompContext('', 'm', 3)).toBeNull()
  })
})
