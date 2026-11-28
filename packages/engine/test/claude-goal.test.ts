// Claude Code 的 /goal（docs/ui/claude-goal.md）：从会话记录里的 goal_status 条目读出目标。
// 条目的样子照 2.1.332 真跑一次的会话记录
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostEvent, SessionGoal } from '@pixelsky/protocol'
import { ClaudeAdapter, EngineHost } from '../src'
import { readClaudeGoal } from '../src/claude/goal'
import { makeTmp, removeTmp } from './helpers/tmp'

const FAKE_CLAUDE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const at = (min: number): string => new Date(Date.UTC(2026, 10, 28, 7, min)).toISOString()
const goal = (min: number, attachment: Record<string, unknown>) => ({
  type: 'attachment',
  uuid: `u${min}`,
  timestamp: at(min),
  attachment: { type: 'goal_status', ...attachment },
})
const other = (min: number) => ({
  type: 'assistant',
  timestamp: at(min),
  message: { content: [{ type: 'text', text: 'x' }] },
})

function transcript(...entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-goal-'))
  dirs.push(dir)
  const file = join(dir, 's.jsonl')
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return file
}

const C = '测试全部通过'

describe('Claude Code /goal 从会话记录读', () => {
  it('没有目标：null；文件读不了也是 null', () => {
    expect(readClaudeGoal(transcript(other(1), other(2)))).toBeNull()
    expect(readClaudeGoal(join(tmpdir(), 'no-such-claude-goal.jsonl'))).toBeNull()
  })

  it('刚设好：进行中，开始时间是设目标那条，没有上次检查、没有用量', () => {
    const g = readClaudeGoal(transcript(other(0), goal(1, { met: false, sentinel: true, condition: C }), other(2)))
    expect(g).toEqual({
      objective: C,
      status: 'active',
      tokensUsed: 0,
      tokenBudget: null,
      timeUsedSeconds: 0,
      updatedAt: Date.parse(at(1)),
      startedAt: Date.parse(at(1)),
    })
  })

  it('检查没达成：还是进行中，带上次检查', () => {
    const g = readClaudeGoal(
      transcript(
        goal(1, { met: false, sentinel: true, condition: C }),
        other(2),
        goal(3, { met: false, condition: C, reason: 'two tests still fail' }),
        other(4),
      ),
    )
    expect(g).toMatchObject({
      status: 'active',
      startedAt: Date.parse(at(1)),
      lastCheck: { reason: 'two tests still fail', at: Date.parse(at(3)), met: false },
    })
    expect(g?.turns).toBeUndefined()
  })

  it('达成：已完成，带 token、用时、轮数和达成时的检查', () => {
    const g = readClaudeGoal(
      transcript(
        goal(1, { met: false, sentinel: true, condition: C }),
        goal(3, { met: false, condition: C, reason: 'not yet' }),
        goal(9, { met: true, condition: C, reason: 'all pass', iterations: 4, durationMs: 480_400, tokens: 284_000 }),
      ),
    )
    expect(g).toMatchObject({
      status: 'complete',
      tokensUsed: 284_000,
      timeUsedSeconds: 480,
      turns: 4,
      startedAt: Date.parse(at(1)),
      lastCheck: { reason: 'all pass', met: true },
    })
  })

  it('判定做不到：卡住了', () => {
    const g = readClaudeGoal(
      transcript(
        goal(1, { met: false, sentinel: true, condition: C }),
        goal(5, {
          met: false,
          failed: true,
          condition: C,
          reason: 'impossible',
          iterations: 2,
          durationMs: 60_000,
          tokens: 9_000,
        }),
      ),
    )
    expect(g).toMatchObject({ status: 'blocked', turns: 2, tokensUsed: 9_000, lastCheck: { reason: 'impossible' } })
  })

  it('/goal clear 之后：null；清掉再设新目标只看新的', () => {
    const cleared = transcript(
      goal(1, { met: false, sentinel: true, condition: C }),
      goal(2, { met: false, condition: C, reason: 'not yet' }),
      goal(3, { met: true, sentinel: true, condition: C }),
    )
    expect(readClaudeGoal(cleared)).toBeNull()
    const next = readClaudeGoal(
      transcript(
        goal(1, { met: false, sentinel: true, condition: C }),
        goal(2, { met: false, condition: C, reason: 'old check' }),
        goal(3, { met: false, sentinel: true, condition: '新目标' }),
      ),
    )
    expect(next).toMatchObject({ objective: '新目标', status: 'active', startedAt: Date.parse(at(3)) })
    expect(next?.lastCheck).toBeUndefined()
  })

  it('写坏的行、子智能体的 goal 以外的条目跳过', () => {
    const file = transcript(goal(1, { met: false, sentinel: true, condition: C }))
    writeFileSync(
      file,
      '{broken\n' +
        JSON.stringify(goal(1, { met: false, sentinel: true, condition: C })) +
        '\n{"type":"attachment","attachment":{"type":"date"}}\n',
    )
    expect(readClaudeGoal(file)?.status).toBe('active')
  })
})

describe('Claude Code /goal 到目标栏', () => {
  const hosts: EngineHost[] = []
  let root = ''
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map(h => h.shutdown()))
    if (root) removeTmp(root)
  })

  it('发 /goal 后会话收到 goal 事件：先是进行中，这一轮结束时达成就变已完成', async () => {
    root = makeTmp('claude-goal')
    const events: HostEvent[] = []
    const projectsDir = join(root, 'claude-projects')
    const adapter = new ClaudeAdapter({
      launcher: { command: process.execPath, args: [FAKE_CLAUDE] },
      projectsDir,
      env: { ...process.env, FAKE_CLAUDE_PROJECTS: projectsDir },
    })
    const host = new EngineHost({
      dataDir: join(root, 'data'),
      emit: e => events.push(e),
      adapters: { claude: adapter },
    })
    hosts.push(host)
    const s = host.createSession({ projectId: host.addProject(root).id })
    const goals = (): (SessionGoal | null)[] =>
      events.flatMap(e =>
        e.kind === 'session' && e.sessionId === s.id && e.event.type === 'goal' ? [e.event.goal] : [],
      )
    await host.send(s.id, '/goal 测试达成')
    const t0 = Date.now()
    while (goals().at(-1)?.status !== 'complete') {
      if (Date.now() - t0 > 8_000)
        throw new Error(
          `等待超时：${JSON.stringify(goals())} ${JSON.stringify(events.map(e => (e.kind === 'session' ? e.event.type : e.kind)))}`,
        )
      await new Promise(r => setTimeout(r, 20))
    }
    expect(goals().at(-1)).toMatchObject({ objective: '测试达成', tokensUsed: 1234, timeUsedSeconds: 90, turns: 2 })
    expect(host.open(s.id).goal).toMatchObject({ status: 'complete' })
    // 达成后点清除：Claude Code 只回「No goal set」、不写记录，目标栏照样收起，之后读记录也不再冒出来
    await host.send(s.id, '/goal clear')
    const t1 = Date.now()
    while (host.open(s.id).goal) {
      if (Date.now() - t1 > 8_000) throw new Error(`清除超时：${JSON.stringify(goals())}`)
      await new Promise(r => setTimeout(r, 20))
    }
    await host.send(s.id, '你好')
    await new Promise(r => setTimeout(r, 1200))
    expect(host.open(s.id).goal ?? null).toBeNull()
  }, 15_000)
})
