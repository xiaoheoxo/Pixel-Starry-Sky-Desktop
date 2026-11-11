// 真 Pixel CLI + 宿主 + 本机模型服务，验证跨进程生命周期；不会访问真实模型或账号。
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { EngineHost, PixelAdapter } from '../src'
import type { HostEvent } from '@pixelsky/protocol'
import { makeTmp, removeTmp } from './helpers/tmp'

type Request = { messages: { content: string | { text?: string }[] }[] }
type Reply = { text: string } | { tool: string; args: Record<string, unknown> }
type ModelGoal = { goal_id: string; objective: string; status: string }
const textOf = (body: Request) =>
  body.messages.map(m =>
    typeof m.content === 'string' ? m.content : (m.content ?? []).map(c => c.text ?? '').join(''),
  )
const goalOf = (body: Request): ModelGoal | null => {
  const text = textOf(body).findLast(t => t.startsWith('[GOAL MODE]\n'))
  return text ? JSON.parse(text.split('\n')[1]) : null
}
const complete = (goal: ModelGoal): Reply => ({
  tool: 'update_goal',
  args: { goal_id: goal.goal_id, status: 'complete' },
})
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function setup(respond: (body: Request, index: number) => Reply | Promise<Reply>) {
  const root = makeTmp('pixel-goal-rpc')
  const requests: Request[] = []
  const events: HostEvent[] = []
  const failures: string[] = []
  const server = createServer(async (req, res) => {
    try {
      let text = ''
      for await (const chunk of req) text += chunk
      const body: Request = JSON.parse(text)
      requests.push(body)
      const index = requests.length
      const reply = await respond(body, index)
      if (res.destroyed) return
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({
        id: `chat-${index}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'goal-test',
        choices: [{ index: 0, delta, finish_reason }],
      })
      const delta =
        'text' in reply
          ? { role: 'assistant', content: reply.text }
          : {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call-${index}`,
                  type: 'function',
                  function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
                },
              ],
            }
      for (const event of [
        chunk(delta),
        chunk({}, 'text' in reply ? 'stop' : 'tool_calls'),
        {
          ...chunk({}),
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        },
      ])
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end('data: [DONE]\n\n')
    } catch (error) {
      failures.push(String(error))
      res.destroy()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env))
    if (/^(ANTHROPIC_|OPENAI_|PIXELSKY_|PI_|ELECTRON_RUN_AS_NODE|HTTPS?_PROXY|ALL_PROXY)/i.test(key)) delete env[key]
  const agentDir = join(root, 'agent')
  mkdirSync(agentDir)
  writeFileSync(
    join(agentDir, 'settings.json'),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
  )
  Object.assign(env, {
    PIXELSKY_CODING_AGENT_DIR: agentDir,
    PIXELSKY_PIXEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    PIXELSKY_PIXEL_TOKEN: 'local-test-key',
    PIXELSKY_PIXEL_API: 'openai-completions',
    PIXELSKY_PIXEL_MODELS: JSON.stringify([
      { id: 'goal-test', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024 },
    ]),
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
  })
  const adapter = new PixelAdapter({
    launcher: { command: process.execPath, args: [fileURLToPath(new URL('../../cli/src/cli.ts', import.meta.url))] },
    env,
    shell: () => ({}),
  })
  let preparationMs = 0
  const openHost = () =>
    new EngineHost({
      dataDir: join(root, 'engine'),
      adapters: { pixel: adapter },
      emit: e => events.push(e),
      idleMs: 60_000,
      validateInput: () => delay(preparationMs),
    })
  let host = openHost()
  const session = host.createSession({
    projectId: host.addProject(root).id,
    engine: 'pixel',
    model: 'pixelsky/goal-test',
    permissionMode: 'ask',
  })
  cleanup = async () => {
    await host.shutdown()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    removeTmp(root)
  }
  const snapshot = () => host.open(session.id)
  const settled = async () => {
    await expect.poll(() => snapshot().state, { timeout: 15000 }).toBe('idle')
    expect(failures).toEqual([])
  }
  return {
    get host() {
      return host
    },
    session,
    requests,
    events,
    prepare: (ms: number) => {
      preparationMs = ms
    },
    snapshot,
    settled,
    async restart() {
      await host.shutdown()
      host = openHost()
    },
    async waitFor(check: () => boolean) {
      await expect
        .poll(check, { timeout: 15000, message: 'Pixel goal RPC did not reach the expected state' })
        .toBe(true)
    },
  }
}

it('starts with /goal, continues through a second run, and stops when the model completes the goal', async () => {
  const s = await setup((body, index) => {
    const goal = goalOf(body)
    if (goal?.status === 'active' && index > 1) return complete(goal)
    return { text: index === 1 ? 'First part done; more work remains.' : 'The goal is complete.' }
  })
  await s.host.send(s.session.id, '/goal Finish both parts')
  await s.waitFor(() => s.snapshot().goal?.status === 'complete')
  await s.settled()
  await delay(250)
  expect(s.requests).toHaveLength(3)
  expect(s.snapshot().goal).toMatchObject({ objective: 'Finish both parts', status: 'complete', tokensUsed: 39 })
  expect(s.snapshot().goal!.timeUsedSeconds).toBeGreaterThan(0)
  expect(
    s
      .snapshot()
      .items.filter(i => i.kind === 'user')
      .map(i => i.text),
  ).toEqual(['/goal Finish both parts'])
  expect(s.snapshot().pending).toEqual([])
  expect(s.events.filter(e => e.kind === 'session' && e.event.type === 'turn_started').length).toBe(3)
  const commands = s.snapshot().commands ?? []
  expect(commands.some(c => c.name === 'goal')).toBe(true)
  expect(commands.some(c => c.name === 'pixelsky-goal')).toBe(false)
}, 25000)

it('pause lets the in-flight request finish; stop cancels it; clear does not start another run', async () => {
  let release: (() => void) | undefined
  let gated = true
  const s = await setup(async () => {
    if (gated)
      await new Promise<void>(resolve => {
        release = resolve
      })
    return { text: 'A partial result.' }
  })
  await s.host.send(s.session.id, '/goal Keep working')
  await s.waitFor(() => s.requests.length === 1)
  await s.host.goal(s.session.id, { kind: 'pause' })
  expect(s.snapshot().state).toBe('running')
  release?.()
  await s.settled()
  await delay(250)
  expect(s.requests).toHaveLength(1)
  gated = false
  await s.host.send(s.session.id, 'Explain this result')
  await s.waitFor(() => s.requests.length === 2)
  await s.settled()
  expect(s.snapshot().goal?.status).toBe('paused')
  gated = true
  await s.host.goal(s.session.id, { kind: 'resume' })
  await s.waitFor(() => s.requests.length === 3)
  await s.host.interrupt(s.session.id)
  release?.()
  await s.settled()
  await delay(250)
  expect(s.requests).toHaveLength(3)
  expect(s.snapshot().goal?.status).toBe('paused')
  await s.host.goal(s.session.id, { kind: 'resume' })
  await s.waitFor(() => s.requests.length === 4)
  await s.host.goal(s.session.id, { kind: 'clear' })
  expect(s.snapshot().state).toBe('running')
  release?.()
  await s.settled()
  await delay(250)
  expect(s.snapshot().goal).toBeNull()
  expect(s.requests).toHaveLength(4)
}, 25000)

it('holds the goal on process shutdown, restores it without a request, and resumes with the next user message', async () => {
  let release: (() => void) | undefined
  let finish = false
  const s = await setup(async body => {
    const goal = goalOf(body)
    if (finish) return goal?.status === 'active' ? complete(goal) : { text: 'All done.' }
    await new Promise<void>(resolve => {
      release = resolve
    })
    return { text: 'Partial progress.' }
  })
  await s.host.send(s.session.id, '/goal Persistent objective')
  await s.waitFor(() => s.requests.length === 1)
  await s.restart()
  release?.()
  const before = s.requests.length
  await s.host.send(s.session.id, '/goal')
  await s.waitFor(() => s.snapshot().goal?.status === 'paused')
  await s.settled()
  await delay(250)
  expect(s.requests).toHaveLength(before)
  finish = true
  await s.host.send(s.session.id, 'Continue with the saved objective')
  await s.waitFor(() => s.snapshot().goal?.status === 'complete')
  await s.settled()
  expect(s.requests.length).toBe(before + 2)
  expect(s.snapshot().goal?.objective).toBe('Persistent objective')
}, 25000)

it('halts automatic requests at the budget and accepts queued user work between goal runs', async () => {
  let release: (() => void) | undefined
  const s = await setup(async (_body, index) => {
    if (index === 1)
      await new Promise<void>(resolve => {
        release = resolve
      })
    return { text: 'More work remains.' }
  })
  await s.host.send(s.session.id, '/goal Budgeted objective')
  await s.waitFor(() => s.requests.length === 1)
  await s.host.goal(s.session.id, { kind: 'set', objective: 'Budgeted objective', tokenBudget: 30 })
  await s.host.send(s.session.id, 'Also cover the edge case')
  release?.()
  await s.waitFor(() => s.snapshot().goal?.status === 'budgetLimited')
  await s.settled()
  await delay(250)
  // 改目标前已经发出的请求不计入新目标；新目标的三次 13 token 请求用到 39 后停止。
  expect(s.requests).toHaveLength(4)
  expect(s.requests.some(body => textOf(body).some(text => text.includes('Also cover the edge case')))).toBe(true)
  expect(s.snapshot().goal).toMatchObject({ tokensUsed: 39, tokenBudget: 30, status: 'budgetLimited' })
  await expect(s.host.goal(s.session.id, { kind: 'resume' })).rejects.toThrow('预算已用完')
}, 25000)

it('a user message takes over an automatic run when host preparation finishes after it starts', async () => {
  const releases: (() => void)[] = []
  const s = await setup(async (body, index) => {
    if (index <= 2) await new Promise<void>(resolve => releases.push(resolve))
    const goal = goalOf(body)
    if (textOf(body).some(text => text.includes('Include the queued requirement')) && goal?.status === 'active')
      return complete(goal)
    return { text: 'Continue after this partial result.' }
  })
  await s.host.send(s.session.id, '/goal Complete the work')
  await s.waitFor(() => s.requests.length === 1)
  s.prepare(300)
  await s.host.send(s.session.id, 'Include the queued requirement')
  releases[0]()
  await s.waitFor(() => s.requests.length === 2)
  await delay(350)
  releases[1]()
  await s.waitFor(() => s.snapshot().goal?.status === 'complete')
  await s.settled()
  expect(s.requests).toHaveLength(4)
  expect(s.snapshot().queue).toEqual([])
  expect(s.snapshot().items.some(i => i.kind === 'notice' && i.level === 'error')).toBe(false)
}, 25000)
