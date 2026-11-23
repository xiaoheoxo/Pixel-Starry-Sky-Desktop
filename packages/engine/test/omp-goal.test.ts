// oh-my-pi 的目标、内置命令的输出、交接、导出（docs/omp-engine.md §13.0–§13.3）
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostEvent } from '@pixelsky/protocol'
import { EngineHost } from '../src'
import { OmpAdapter } from '../src/omp'
import { ompGoal, ompOutput } from '../src/omp/goal'
import { makeTmp, removeTmp } from './helpers/tmp'

const FAKE = fileURLToPath(new URL('./fakes/fake-omp.mjs', import.meta.url))
let root: string, host: EngineHost | undefined, events: HostEvent[]
beforeEach(() => {
  root = makeTmp('omp-goal')
  events = []
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
  throw new Error('omp goal test timed out')
}
const rows = (file: string) =>
  existsSync(join(root, file))
    ? readFileSync(join(root, file), 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
    : []

function open(extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|PIXELSKY_PIXEL)_/i.test(key)) delete env[key]
  const adapter = new OmpAdapter({
    launcher: { command: process.execPath, args: [FAKE] },
    env: {
      ...env,
      FAKE_OMP_LOG: join(root, 'rpc.jsonl'),
      FAKE_OMP_ARGV: join(root, 'argv.jsonl'),
      FAKE_OMP_DIR: join(root, 'sessions'),
      ...extraEnv,
    },
    dataDir: join(root, 'engine'),
  })
  return (host = new EngineHost({
    dataDir: join(root, 'engine'),
    adapters: { omp: adapter },
    emit: e => events.push(e),
    idleMs: 10_000,
  }))
}
function setup(extraEnv: Record<string, string> = {}) {
  const h = open(extraEnv)
  const { id } = h.createSession({
    projectId: h.addProject(root).id,
    engine: 'omp',
    model: 'fake/fake-omp',
    permissionMode: 'ask',
  })
  return { h, id }
}
const snap = (id: string) => host!.open(id)
const idle = (id: string) => snap(id).state === 'idle'
const texts = (id: string) => snap(id).items.flatMap(i => (i.kind === 'assistant' ? [i.text] : []))
const notices = (id: string) => snap(id).items.flatMap(i => (i.kind === 'notice' ? [i.text] : []))
const turns = (type: 'turn_started' | 'turn_completed') =>
  events.flatMap(e => (e.kind === 'session' && e.event.type === type ? [e.event] : []))

describe('oh-my-pi 目标', () => {
  it('输入框发 /goal：不发给模型，接着做的每一次各是一轮，完成后目标清空并说一句', async () => {
    const { h, id } = setup()
    await h.send(id, '/goal 做 3 次')
    await wait(() => idle(id) && texts(id).length === 3)
    expect(texts(id)).toEqual(['目标第 1 次', '目标第 2 次', '目标第 3 次'])
    expect(notices(id)).toContain('目标已完成：做 3 次')
    expect(snap(id).goal ?? null).toBeNull()
    await wait(() => turns('turn_completed').length === 3)
    expect(turns('turn_completed').every(t => t.type === 'turn_completed' && t.outcome === 'completed')).toBe(true)
    expect(turns('turn_started')).toHaveLength(3)
    expect(rows('rpc.jsonl').filter(m => m.type === 'prompt' && String(m.message).startsWith('/goal'))).toEqual([])
  })

  it('进程在跑时直接设；做着的时候发的消息送进去，目标接着做', async () => {
    const { h, id } = setup()
    await h.send(id, '你好')
    await wait(() => idle(id))
    expect(await h.goal(id, { kind: 'set', objective: '慢 做 6 次' })).toMatchObject({ status: 'active' })
    await wait(() => texts(id).includes('目标第 1 次'))
    await h.send(id, '插一句')
    await wait(() => texts(id).includes('目标第 6 次') && idle(id))
    expect(texts(id)).toContain('收到：插一句')
    expect(
      snap(id)
        .items.filter(i => i.kind === 'user')
        .map(i => i.kind === 'user' && i.text),
    ).toEqual(['你好', '插一句'])
    expect(snap(id).queue).toEqual([])
    expect(turns('turn_completed').every(t => t.type === 'turn_completed' && t.outcome === 'completed')).toBe(true)
  })

  it('停止：目标暂停，之后的消息不会让它接着做；继续才接着', async () => {
    const { h, id } = setup()
    await h.send(id, '/goal 慢')
    await wait(() => texts(id).length >= 2)
    await h.interrupt(id)
    await wait(() => idle(id))
    expect(snap(id).goal?.status).toBe('paused')
    expect(snap(id).record.goalHeldAt ?? null).toBeNull()
    const before = texts(id).length
    await h.send(id, '在吗')
    await wait(() => idle(id) && texts(id).length === before + 1)
    await new Promise(r => setTimeout(r, 150))
    expect(texts(id)).toHaveLength(before + 1)
    await h.goal(id, { kind: 'resume' })
    await wait(() => texts(id).length > before + 2)
    expect(await h.goal(id, { kind: 'clear' })).toBeNull()
    await wait(() => idle(id))
  })

  it('Codex 停下的目标不当成自己的：用户在 omp 里暂停的目标不会被接着做', async () => {
    const { h, id } = setup()
    await h.send(id, '/goal 慢')
    await wait(() => texts(id).length >= 2)
    await h.interrupt(id)
    await wait(() => idle(id))
    const before = texts(id).length
    // 换到 Codex 时它的目标进行中，关进程记下的
    ;(h as unknown as { m: { events: { patchRecord(id: string, p: object): void } } }).m.events.patchRecord(id, {
      goalHeldAt: Date.now(),
    })
    await h.send(id, '在吗')
    await wait(() => idle(id) && texts(id).length === before + 1)
    await new Promise(r => setTimeout(r, 150))
    expect(texts(id)).toHaveLength(before + 1)
    expect(snap(id).goal?.status).toBe('paused')
  })

  it('没有进展停下：目标还在，说一句怎么接着做；空闲时关进程也记下来', async () => {
    const { h, id } = setup()
    await h.send(id, '/goal 没进展')
    await wait(() => idle(id) && texts(id).length === 1)
    expect(notices(id).at(-1)).toMatch(/^这一轮没有新的进展/)
    expect(snap(id).goal?.status).toBe('active')
    await h.send(id, '接着')
    await wait(() => idle(id) && texts(id).length === 3)
    expect(texts(id)).toEqual(['目标第 1 次', '好的', '目标第 2 次'])
  })

  it('关了再开：不自己开跑，发一条消息后接着做（启动时用 --session 打开，不用 switch_session）', async () => {
    const { h, id } = setup()
    await h.send(id, '/goal 慢')
    await wait(() => texts(id).length >= 2)
    await h.shutdown()
    open()
    expect(snap(id).record.goalHeldAt).toBeLessThan(0)
    const before = texts(id).length
    await host!.send(id, '接着')
    await wait(() => texts(id).length > before + 2)
    expect(texts(id)[before]).toBe('好的')
    expect(rows('argv.jsonl').at(-1).argv).toContain('--session')
    expect(snap(id).record.goalHeldAt ?? null).toBeNull()
    await host!.interrupt(id)
    await wait(() => idle(id))
  })

  it('做着的时候换权限档：这一次做完换进程，目标先停下并说一句', async () => {
    const { h, id } = setup()
    await h.send(id, '/goal 慢')
    await wait(() => texts(id).length >= 2)
    await h.update(id, { permissionMode: 'full' })
    // 两次之间有一瞬间算空闲，等换了进程的提示
    await wait(() => notices(id).includes('设置改了，oh-my-pi 换了进程，目标先停下；发一条消息后接着做') && idle(id))
    expect(snap(id).record.goalHeldAt).toBeTruthy()
    const before = texts(id).length
    await new Promise(r => setTimeout(r, 150))
    expect(texts(id)).toHaveLength(before)
  })

  it('有目标的会话分叉：分出来的没有目标，也不自己开跑', async () => {
    const { h, id } = setup()
    await h.send(id, '第一句')
    await wait(() => idle(id))
    await h.goal(id, { kind: 'set', objective: '慢' })
    await wait(() => texts(id).includes('目标第 2 次'))
    await h.interrupt(id)
    await wait(() => idle(id))
    expect(snap(id).goal?.status).toBe('paused')
    const branch = (await h.forkSession(id, null)).record
    const before = texts(branch.id).length
    await h.send(branch.id, '分支里问')
    await wait(() => idle(branch.id))
    await new Promise(r => setTimeout(r, 150))
    expect(texts(branch.id).slice(before)).toEqual(['好的'])
    expect(snap(branch.id).goal ?? null).toBeNull()
  })

  it('计划档不能设；旧版没有目标接口时说明、菜单不列', async () => {
    const { h, id } = setup()
    await h.update(id, { permissionMode: 'plan' })
    await h.send(id, '/goal 做 1 次')
    await wait(() => idle(id) && notices(id).length > 0)
    expect(notices(id)).toContain('先退出计划模式，再设目标或继续目标')
    await h.shutdown()
    const old = setup({ FAKE_OMP_NO_GOAL: '1' })
    await old.h.send(old.id, '/goal 做 1 次')
    await wait(() => idle(old.id) && notices(old.id).length > 0)
    expect(notices(old.id)[0]).toMatch(/没有目标模式/)
    expect((snap(old.id).commands ?? []).map(c => c.name)).not.toContain('goal')
  })

  it('格式：清掉的、不认识的当没有；预算用完', () => {
    expect(ompGoal({ objective: 'x', status: 'dropped' })).toBeNull()
    expect(ompGoal(null)).toBeNull()
    expect(ompGoal({ objective: 'x', status: 'budget-limited', tokenBudget: 20, tokensUsed: 30 })).toMatchObject({
      status: 'budgetLimited',
      tokenBudget: 20,
    })
  })
})

describe('内置命令的输出', () => {
  it('显示成提示，去掉终端颜色，长的折叠', async () => {
    const { h, id } = setup()
    await h.send(id, '/usage')
    await wait(() => idle(id))
    expect(snap(id).items.find(i => i.kind === 'notice')).toMatchObject({ text: 'Usage\nTotal: 0', detail: null })
    const long = Array.from({ length: 11 }, (_, i) => `第 ${i} 行`).join('\n')
    expect(ompOutput(long)).toEqual({ text: '第 0 行', detail: long })
    expect(ompOutput('一行')).toEqual({ text: '一行', detail: null })
    expect(ompOutput(' \u001b[0m ')).toBeNull()
  })
})

describe('交接（/handoff）', () => {
  const compactions = (id: string) => snap(id).items.flatMap(i => (i.kind === 'compaction' ? [i] : []))
  it('不当提示发：等它做完，条目里有文档和压缩后的大小；/compact handoff 一样，/compact 还是压缩', async () => {
    const { h, id } = setup()
    await h.send(id, '你好')
    await wait(() => idle(id))
    await h.send(id, '/handoff 留下要点')
    await wait(() => idle(id) && compactions(id).length === 1)
    expect(compactions(id)[0]).toMatchObject({
      status: 'completed',
      handoff: '## Goal\n留下要点',
      preTokens: 900,
      postTokens: 321,
    })
    await h.send(id, '/compact handoff 再来')
    await wait(() => idle(id) && compactions(id).length === 2)
    expect(compactions(id)[1].handoff).toBe('## Goal\n再来')
    await h.send(id, '/compact 普通')
    await wait(() => idle(id) && compactions(id).length === 3)
    expect(compactions(id)[2].handoff).toBeUndefined()
    expect(rows('rpc.jsonl').filter(m => m.type === 'prompt' && /handoff|compact/.test(String(m.message)))).toEqual([])
    expect(turns('turn_completed').every(t => t.type === 'turn_completed' && t.outcome === 'completed')).toBe(true)
    // omp 自己也列 /compact：菜单里只有一条
    expect((snap(id).commands ?? []).map(c => c.name).filter(n => n === 'compact')).toHaveLength(1)
    const { ompReadNative } = await import('../src/omp/native')
    const read = await ompReadNative(snap(id).record.engineSessionId!)
    expect(read!.items.filter(i => i.kind === 'compaction').map(i => i.kind === 'compaction' && i.handoff)).toEqual([
      '## Goal\n留下要点',
      '## Goal\n再来',
      undefined,
    ])
  })

  it('没成的原因写在条目上，不另报错；停止算中断', async () => {
    const { h, id } = setup()
    for (const [want, reason] of [
      ['太小', 'Nothing to compact (session too small)'],
      ['写坏', 'Handoff generation produced an invalid document'],
    ]) {
      await h.send(id, `/handoff ${want}`)
      await wait(() => idle(id) && compactions(id).at(-1)?.error === reason)
      expect(compactions(id).at(-1)).toMatchObject({ status: 'failed', handoff: '' })
    }
    expect(notices(id)).toEqual([])
    await h.send(id, '/handoff 慢')
    await wait(() => compactions(id).at(-1)?.status === 'running')
    await h.interrupt(id)
    await wait(() => idle(id))
    expect(compactions(id).at(-1)!.status).toBe('interrupted')
    expect(turns('turn_completed').at(-1)).toMatchObject({ outcome: 'interrupted' })
  })
})

describe('导出 HTML', () => {
  it('读会话文件导出，不另起会话；没发过消息、回退还没落实、导出失败说明原因', async () => {
    const { h, id } = setup()
    await expect(h.exportHtml(id)).rejects.toThrow('先发一条消息')
    for (const text of ['一', '二']) {
      await h.send(id, text)
      await wait(() => idle(id))
    }
    const before = rows('argv.jsonl').length
    const size = readFileSync(snap(id).record.engineSessionId!, 'utf8').length
    expect(await h.exportHtml(id)).toBe(`<html>${size}</html>`)
    expect(rows('argv.jsonl')).toHaveLength(before + 1)
    const user = snap(id).items.find(i => i.kind === 'user' && i.text === '二')!
    await h.rewind(id, user.id)
    await expect(h.exportHtml(id)).rejects.toThrow('回退之后先发一条消息')
    await h.shutdown()
    const bad = setup({ FAKE_OMP_EXPORT_FAIL: '1' })
    await bad.h.send(bad.id, '一')
    await wait(() => idle(bad.id))
    await expect(bad.h.exportHtml(bad.id)).rejects.toThrow('bad session')
  })
})
