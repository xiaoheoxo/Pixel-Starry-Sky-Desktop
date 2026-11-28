// Antigravity 会话：用 Node 写的假 agy acp 跑完整流程（照 P0 录像的消息形状，docs/antigravity-engine.md §7）
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import type { EngineEvent, SessionRecord } from '@pixelsky/protocol'
import type { SessionContext } from '../src/adapter'
import type { AgyProcessOps } from '../src/antigravity/background'
import { nextPlanReturn, reportedMode } from '../src/host/plan-return'
import { AntigravitySession, agySystemPrompt, pickEffort, type AgyLaunch } from '../src/antigravity/session'
import { agyModels } from '../src/antigravity/discover'

const dir = mkdtempSync(join(tmpdir(), 'pixelsky-agy-session-'))
const fake = join(dir, 'fake-agy.mjs')
// 收到的请求记在 FAKE_LOG 里；prompt 文字里带 tool / slow / err 决定这一轮怎么走
writeFileSync(
  fake,
  `
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const out = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
const log = m => appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + '\\n')
const opts = () => [
  { id: 'model', currentValue: model, options: [{ value: 'gemini-3.1-pro', name: 'Pro' }, { value: 'gemini-3.8-flash', name: 'Flash' }] },
  { id: 'thought_level', currentValue: level, options: (model === 'gemini-3.1-pro' ? ['low', 'high'] : ['low', 'medium', 'high']).map(v => ({ value: v, name: v })) },
  { id: 'mode', currentValue: mode, options: ['default', 'accept-edits', 'plan'].map(v => ({ value: v, name: v })) },
]
let model = 'gemini-3.1-pro', level = 'low', mode = 'default', waiting = null, cancelTurn = null
const upd = (update) => out({ method: 'session/update', params: { sessionId: 's1', update } })
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  log(m)
  if (m.id === 'p1' && waiting) return waiting(m.result)
  if (m.method === 'initialize') return out({ id: m.id, result: { protocolVersion: 1 } })
  if (m.method === 'authenticate') return out({ id: m.id, result: {} })
  if (m.method === 'session/new') return out({ id: m.id, result: { sessionId: 's1', configOptions: opts() } })
  // crash：接上时进程退出（和超时一样不是 agy 回的错误）
  if (m.method === 'session/resume' && m.params.sessionId === 'crash') process.exit(1)
  if (m.method === 'session/resume')
    return m.params.sessionId === 's1' ? out({ id: m.id, result: { configOptions: opts() } }) : out({ id: m.id, error: { code: -32603, message: 'not found' } })
  if (m.method === 'session/set_config_option') {
    if (m.params.configId === 'model') model = m.params.value
    if (m.params.configId === 'thought_level') level = m.params.value
    if (m.params.configId === 'mode') mode = m.params.value
    out({ id: m.id, result: { configOptions: opts() } })
    if (m.params.configId === 'mode') {
      // 实测（1.5.14）：应答之后再单独推 current_mode_update、config_option_update，可能晚于下一次切换
      const currentModeId = mode, configOptions = opts(), late = Number(process.env.FAKE_LATE ?? 0)
      setTimeout(() => upd({ sessionUpdate: 'current_mode_update', currentModeId }), late)
      setTimeout(() => upd({ sessionUpdate: 'config_option_update', configOptions }), late)
    }
    return
  }
  if (m.method === 'session/cancel') return cancelTurn?.()
  if (m.method !== 'session/prompt') return
  const text = m.params.prompt[0].text
  const end = (stopReason = 'end_turn') => out({ id: m.id, result: { stopReason, usage: { inputTokens: 10, outputTokens: 2, cachedReadTokens: 5, cachedWriteTokens: 0 } } })
  upd({ sessionUpdate: 'usage_update', used: 100, size: 1000 })
  if (text.includes('switch:')) { mode = text.split('switch:')[1]; upd({ sessionUpdate: 'current_mode_update', currentModeId: mode }); return end() }
  if (text.includes('slow') || (text === '/compact' && process.env.FAKE_SLOW_COMPACT)) { cancelTurn = () => end('cancelled'); return }
  if (text.includes('err')) { upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\\n⚠ agent executor error: Error 404 no model\\n' } }); return end() }
  if (text.includes('ask')) {
    const call = { toolCallId: 'q1', name: 'ask_question', kind: 'other', title: 'Run ask_question', rawInput: { questions: [{ question: 'Red or blue?', options: ['(Recommended) Red', 'Blue'], is_multi_select: false }] } }
    upd({ sessionUpdate: 'tool_call', ...call, status: 'in_progress' })
    upd({ sessionUpdate: 'tool_call_update', ...call, status: 'pending' })
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Red or blue?\\n- [1] Red' } })
    return end()
  }
  if (text.includes('mcp')) {
    const call = { toolCallId: 'm1', name: text.includes('evil') ? 'mcp_pixelsky_threads_x_steal' : 'mcp_pixelsky_threads_list_threads', kind: 'other', title: 'Run mcp_pixelsky_threads_list_threads', rawInput: {} }
    upd({ sessionUpdate: 'tool_call', ...call, status: 'pending' })
    out({ id: 'p1', method: 'session/request_permission', params: { sessionId: 's1', toolCall: call, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } })
    waiting = () => { waiting = null; upd({ sessionUpdate: 'tool_call_update', ...call, status: 'completed' }); end() }
    return
  }
  if (text.includes('bg:')) {
    const cmd = text.includes('bg:dev') ? 'pnpm dev' : 'pnpm build'
    const tid = text.includes('bg:dev') ? 's1/task-76' : 's1/task-77'
    const logUrl = process.env.FAKE_BG_LOG_URL || ''
    const call = { toolCallId: 'bg1', name: 'run_command', kind: 'execute', title: cmd, rawInput: { CommandLine: cmd, toolSummary: 'Background run' } }
    upd({ sessionUpdate: 'tool_call', ...call, status: 'in_progress' })
    upd({
      sessionUpdate: 'tool_call_update',
      ...call,
      status: 'completed',
      rawOutput: {
        output: 'Tool is running as a background task with task id: ' + tid + '\\nTask logs are available at: ' + logUrl + '\\nYOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: ...',
        exit_code: 0,
      },
    })
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已在后台启动' } })
    return end()
  }
  if (text.includes('tool')) {
    const call = { toolCallId: 'c1', name: 'run_command', kind: 'execute', title: 'echo hi', rawInput: { CommandLine: 'echo hi' } }
    upd({ sessionUpdate: 'tool_call', ...call, status: 'in_progress' })
    upd({ sessionUpdate: 'tool_call_update', ...call, status: 'pending' })
    out({ id: 'p1', method: 'session/request_permission', params: { sessionId: 's1', toolCall: call, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } })
    waiting = r => {
      waiting = null
      if (r.outcome.optionId === 'deny') { upd({ sessionUpdate: 'tool_call_update', ...call, status: 'failed' }); return end() }
      upd({ sessionUpdate: 'tool_call_update', ...call, status: 'completed', rawOutput: { output: 'Command output:\\nhi\\r\\n', exit_code: 0 } })
      upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })
      end()
    }
    return
  }
  upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } })
  end()
})
`,
)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
function setup(
  record: Partial<SessionRecord> = {},
  launch?: AgyLaunch,
  extensions?: SessionContext['extensions'],
  processOps?: AgyProcessOps,
  bgPollMs?: number,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const logFile = join(dir, `log-${++n}.ndjson`)
  writeFileSync(logFile, '')
  const events: EngineEvent[] = []
  let rec = {
    cwd: dir,
    engineSessionId: null,
    model: 'gemini-3.8-flash',
    effort: 'high',
    permissionMode: 'edits',
    ...record,
  } as SessionRecord
  const ctx = {
    record: () => rec,
    extensions,
    emit: (e: EngineEvent) => events.push(e),
    setEngineSessionId: (id: string) => (rec = { ...rec, engineSessionId: id }),
    // 和宿主一样（host/turn.ts）
    setPermissionMode: (reported: SessionRecord['permissionMode']) => {
      const { permissionMode, planReturn, push } = reportedMode(rec, reported)
      rec = { ...rec, permissionMode, planReturn }
      if (push) void Promise.resolve().then(() => session.update({ permissionMode }))
    },
    setUltracode: () => {},
    setFast: () => {},
    setEffort: (effort: SessionRecord['effort']) => (rec = { ...rec, effort }),
  } as unknown as SessionContext
  const env = { ...process.env, FAKE_LOG: logFile, GEMINI_API_KEY: 'k', ...extraEnv }
  const session: AntigravitySession = new AntigravitySession(
    { command: process.execPath, args: [fake] },
    env,
    ctx,
    [],
    launch,
    processOps,
    bgPollMs,
  )
  const sent = (): Record<string, any>[] =>
    (require('node:fs').readFileSync(logFile, 'utf8') as string)
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
  const turnDone = (turnId: string): Promise<EngineEvent> =>
    new Promise(resolve => {
      const tick = (): void => {
        const e = events.find(x => x.type === 'turn_completed' && x.turnId === turnId)
        if (e) resolve(e)
        else setTimeout(tick, 20)
      }
      tick()
    })
  /** 用户换权限档，和宿主一样先改记录再发给会话 */
  const pick = (permissionMode: SessionRecord['permissionMode']): Promise<void> => {
    rec = { ...rec, planReturn: nextPlanReturn(rec, permissionMode, undefined), permissionMode }
    return session.update({ permissionMode })
  }
  return { session, events, sent, turnDone, pick, rec: () => rec, ctx }
}

describe('Antigravity 换权限档（plan-mode-split.md §11）', () => {
  type Mode = SessionRecord['permissionMode']
  const AGY: Record<string, string> = { ask: 'default', edits: 'accept-edits', full: 'accept-edits', plan: 'plan' }
  const start = async (late?: string) => {
    const t = setup(
      { permissionMode: 'ask' },
      undefined,
      undefined,
      undefined,
      undefined,
      late ? { FAKE_LATE: late } : {},
    )
    t.session.send('hi', 't0', 'u0')
    await t.turnDone('t0')
    return {
      ...t,
      /** agy 现在的模式：最后一次设的，没设过是 default */
      agy: () =>
        t
          .sent()
          .filter(m => m.method === 'session/set_config_option' && m.params.configId === 'mode')
          .at(-1)?.params.value ?? 'default',
      settle: () => new Promise(r => setTimeout(r, 200)),
    }
  }
  const LISTS: [Mode[]][] = [
    [['full', 'ask']],
    [['plan', 'ask']],
    [['full', 'ask', 'plan']],
    [['edits', 'full', 'plan']],
    [['plan', 'full', 'plan']],
    [['plan', 'full', 'ask']],
  ]
  it.each(LISTS)('不等应答连着切 %j：停在最后选的那档', async list => {
    const { pick, rec, agy, settle, session } = await start()
    await Promise.all(list.map(pick))
    await settle()
    expect(rec().permissionMode).toBe(list.at(-1))
    expect(agy()).toBe(AGY[list.at(-1)!])
    await session.close()
  })
  it.each(LISTS)('通知晚到时连着切 %j：停在最后选的那档', async list => {
    const { pick, rec, agy, settle, session } = await start('30')
    for (const m of list) await pick(m)
    await settle()
    expect(rec().permissionMode).toBe(list.at(-1))
    expect(rec().planReturn ?? null).toBe(list.at(-1) === 'plan' ? list.at(-2) : null)
    expect(agy()).toBe(AGY[list.at(-1)!])
    // 晚到的 config_option_update 也不能让下一次切换被当成没变
    await pick('ask')
    await settle()
    expect(agy()).toBe('default')
    await session.close()
  })
  it('agy 自己换的模式照样认', async () => {
    const { pick, rec, agy, settle, session, turnDone } = await start()
    await pick('full')
    await pick('plan')
    await settle()
    session.send('switch:default', 't1', 'u1')
    await turnDone('t1')
    await settle()
    // 计划中退出：回到进计划前那档，并推回 agy
    expect(rec()).toMatchObject({ permissionMode: 'full', planReturn: null })
    expect(agy()).toBe('accept-edits')
    session.send('switch:plan', 't2', 'u2')
    await turnDone('t2')
    expect(rec()).toMatchObject({ permissionMode: 'plan', planReturn: 'full' })
    await session.close()
  })
})

describe('Antigravity 会话（假 agy）', () => {
  it('提问：弹提问卡片、这一轮不结束，回答当下一次 prompt 发回去；文字版的问题不显示', async () => {
    const t = setup()
    t.session.send('ask me', 't1', 'u1')
    const card = await new Promise<EngineEvent & { type: 'approval_request' }>(resolve => {
      const tick = (): void => {
        const e = t.events.find(x => x.type === 'approval_request')
        if (e) resolve(e as never)
        else setTimeout(tick, 20)
      }
      tick()
    })
    expect(card.request).toMatchObject({
      kind: 'question',
      questions: [{ question: 'Red or blue?', options: [{ label: '(Recommended) Red' }, { label: 'Blue' }] }],
    })
    expect(t.events.some(e => e.type === 'turn_completed')).toBe(false)
    expect(t.events.some(e => e.type === 'item_started' && e.item.kind === 'assistant')).toBe(false)
    t.session.answer(card.request.requestId, { type: 'answer', answers: { 'Red or blue?': 'Blue' } })
    expect(await t.turnDone('t1')).toMatchObject({ outcome: 'completed' })
    const prompts = t
      .sent()
      .filter(m => m.method === 'session/prompt')
      .map(m => m.params.prompt[0].text)
    expect(prompts).toEqual(['ask me', 'Red or blue?\n→ Blue'])
    await t.session.close()
  })

  it('停止正在等回答的提问：这一轮算中断', async () => {
    const t = setup()
    t.session.send('ask me', 't1', 'u1')
    await new Promise(r => setTimeout(r, 400))
    await t.session.interrupt()
    expect(await t.turnDone('t1')).toMatchObject({ outcome: 'interrupted' })
    await t.session.close()
  })

  it('应用自己的 MCP 工具不弹审批，自动允许', async () => {
    const t = setup({}, undefined, {
      key: 'mcp:pixelsky_threads',
      pluginDirs: [],
      pathDirs: [],
      acpMcp: [{ type: 'http', name: 'pixelsky_threads', url: 'http://127.0.0.1:1/mcp', headers: {}, own: true }],
    })
    t.session.send('mcp', 't1', 'u1')
    await t.turnDone('t1')
    expect(t.events.some(e => e.type === 'approval_request')).toBe(false)
    expect(t.sent().find(m => m.id === 'p1')?.result.outcome.optionId).toBe('allow')
    expect(t.events.find(e => e.type === 'item_completed' && e.item.kind === 'tool')).toMatchObject({
      item: { tool: 'mcp', title: 'pixelsky_threads_list_threads' },
    })
    await t.session.close()
  })

  it('设置：系统提示追加、应用的 MCP 走会话参数；用量到阈值后下一条先发 /compact', async () => {
    const launch = { askQuestions: false, autoPlan: true, autoCompactPct: 10 }
    const t = setup({}, launch, {
      key: 'mcp:pixelsky_threads',
      pluginDirs: [],
      pathDirs: [],
      acpMcp: [
        {
          type: 'http',
          name: 'pixelsky_threads',
          url: 'http://127.0.0.1:1/mcp',
          headers: { Authorization: 'Bearer t' },
          own: true,
        },
        { type: 'stdio', name: 'fs', command: 'npx', args: ['-y', 'fs'], env: { TOKEN: 'x' } },
      ],
    })
    t.session.send('hi', 't1', 'u1')
    await t.turnDone('t1')
    const created = t.sent().find(m => m.method === 'session/new')!
    expect(created.params.mcpServers).toEqual([
      {
        type: 'http',
        name: 'pixelsky_threads',
        url: 'http://127.0.0.1:1/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer t' }],
      },
      { name: 'fs', command: 'npx', args: ['-y', 'fs'], env: [{ name: 'TOKEN', value: 'x' }] },
    ])
    expect(created.params._meta.antigravity.systemPrompt.append).toBe(agySystemPrompt(launch))
    // 假 agy 每轮报 100 / 1000 = 10%，到了阈值
    t.session.send('again', 't2', 'u2')
    await t.turnDone('t2')
    const prompts = t
      .sent()
      .filter(m => m.method === 'session/prompt')
      .map(m => m.params.prompt[0].text)
    expect(prompts).toEqual(['hi', '/compact', 'again'])
    await t.session.close()
  })

  it('新建会话：Key 认证、记下会话 id、设好模型 / 档位 / 模式，一轮回复带用量', async () => {
    const t = setup()
    t.session.send('hi', 't1', 'u1')
    const done = await t.turnDone('t1')
    expect(done).toMatchObject({ outcome: 'completed', error: null })
    expect((done as { usage: { models: Record<string, unknown> } }).usage.models['gemini-3.8-flash']).toMatchObject({
      input: 10,
      cacheRead: 5,
      output: 2,
    })
    expect(t.rec().engineSessionId).toBe('s1')
    const methods = t.sent().map(m => m.method)
    expect(methods.slice(0, 3)).toEqual(['initialize', 'authenticate', 'session/new'])
    const sets = t
      .sent()
      .filter(m => m.method === 'session/set_config_option')
      .map(m => [m.params.configId, m.params.value])
    expect(sets).toEqual([
      ['model', 'gemini-3.8-flash'],
      ['thought_level', 'high'],
      ['mode', 'accept-edits'],
    ])
    expect(t.events.some(e => e.type === 'item_started' && e.item.kind === 'assistant')).toBe(true)
    expect(t.events.some(e => e.type === 'usage' && e.usage.contextTokens === 100)).toBe(true)
    await t.session.close()
  })

  it('审批：允许后命令跑完；拒绝后工具失败、这一轮结束', async () => {
    const t = setup()
    t.session.send('tool', 't1', 'u1')
    const ask = await new Promise<EngineEvent & { type: 'approval_request' }>(resolve => {
      const tick = (): void => {
        const e = t.events.find(x => x.type === 'approval_request')
        if (e) resolve(e as never)
        else setTimeout(tick, 20)
      }
      tick()
    })
    expect(ask.request).toMatchObject({ kind: 'command', command: 'echo hi', alwaysScopes: ['session'] })
    t.session.answer(ask.request.requestId, { type: 'allow' })
    await t.turnDone('t1')
    expect(t.events.find(e => e.type === 'item_completed' && e.item.kind === 'command')).toMatchObject({
      item: { output: 'hi', exitCode: 0, status: 'completed' },
    })
    t.session.send('tool again', 't2', 'u2')
    await new Promise(r => setTimeout(r, 300))
    const second = t.events.filter(e => e.type === 'approval_request').pop() as EngineEvent & {
      type: 'approval_request'
    }
    t.session.answer(second.request.requestId, { type: 'deny' })
    expect(await t.turnDone('t2')).toMatchObject({ outcome: 'completed' })
    expect(
      t
        .sent()
        .filter(m => m.id === 'p1')
        .map(m => m.result.outcome.optionId),
    ).toEqual(['allow', 'deny'])
    await t.session.close()
  })

  it('本会话不再询问：同一条命令之后直接允许，不再弹卡片', async () => {
    const t = setup()
    t.session.send('tool', 't1', 'u1')
    const ask = await new Promise<EngineEvent & { type: 'approval_request' }>(resolve => {
      const tick = (): void => {
        const e = t.events.find(x => x.type === 'approval_request')
        if (e) resolve(e as never)
        else setTimeout(tick, 20)
      }
      tick()
    })
    t.session.answer(ask.request.requestId, { type: 'allow_always', scope: 'session' })
    await t.turnDone('t1')
    t.session.send('tool again', 't2', 'u2')
    expect(await t.turnDone('t2')).toMatchObject({ outcome: 'completed' })
    expect(t.events.filter(e => e.type === 'approval_request')).toHaveLength(1)
    expect(
      t
        .sent()
        .filter(m => m.id === 'p1')
        .map(m => m.result.outcome.optionId),
    ).toEqual(['allow', 'allow'])
    await t.session.close()
  })

  it('完全放行：agy 设成 accept-edits，剩下的权限请求直接允许', async () => {
    const t = setup({ permissionMode: 'full' })
    t.session.send('tool', 't1', 'u1')
    expect(await t.turnDone('t1')).toMatchObject({ outcome: 'completed' })
    expect(t.events.some(e => e.type === 'approval_request')).toBe(false)
    expect(
      t.sent().find(m => m.method === 'session/set_config_option' && m.params.configId === 'mode')?.params.value,
    ).toBe('accept-edits')
    expect(t.sent().find(m => m.id === 'p1')?.result.outcome.optionId).toBe('allow')
    await t.session.close()
  })

  it('扩展的服务名以应用自己的服务名开头时，它的工具照常审批', async () => {
    const t = setup({}, undefined, {
      key: 'k',
      pluginDirs: [],
      pathDirs: [],
      acpMcp: [
        { type: 'http', name: 'pixelsky_threads', url: 'http://127.0.0.1:1/mcp', headers: {}, own: true },
        { type: 'http', name: 'pixelsky_threads_x', url: 'http://127.0.0.1:2/mcp', headers: {} },
      ],
    })
    t.session.send('mcp evil', 't1', 'u1')
    const ask = await new Promise<EngineEvent & { type: 'approval_request' }>(resolve => {
      const tick = (): void => {
        const e = t.events.find(x => x.type === 'approval_request')
        if (e) resolve(e as never)
        else setTimeout(tick, 20)
      }
      tick()
    })
    t.session.answer(ask.request.requestId, { type: 'deny' })
    await t.turnDone('t1')
    await t.session.close()
  })

  it('代发 /compact 时点停止：发 session/cancel，这一轮算中断', async () => {
    process.env.FAKE_SLOW_COMPACT = '1'
    const t = setup({}, { askQuestions: true, autoPlan: false, autoCompactPct: 10 })
    delete process.env.FAKE_SLOW_COMPACT
    t.session.send('hi', 't1', 'u1')
    await t.turnDone('t1')
    t.session.send('again', 't2', 'u2')
    await new Promise(r => setTimeout(r, 400))
    await t.session.interrupt()
    expect(await t.turnDone('t2')).toMatchObject({ outcome: 'interrupted' })
    expect(t.sent().some(m => m.method === 'session/cancel')).toBe(true)
    expect(
      t
        .sent()
        .filter(m => m.method === 'session/prompt')
        .map(m => m.params.prompt[0].text),
    ).toEqual(['hi', '/compact'])
    await t.session.close()
  })

  it('停止：发 session/cancel，这一轮算中断', async () => {
    const t = setup()
    t.session.send('slow', 't1', 'u1')
    await new Promise(r => setTimeout(r, 400))
    await t.session.interrupt()
    expect(await t.turnDone('t1')).toMatchObject({ outcome: 'interrupted' })
    expect(t.sent().some(m => m.method === 'session/cancel')).toBe(true)
    await t.session.close()
  })

  it('模型出错（错误前缀的回复）：这一轮失败，错误进提示', async () => {
    const t = setup()
    t.session.send('err', 't1', 'u1')
    const done = await t.turnDone('t1')
    expect(done).toMatchObject({ outcome: 'failed' })
    expect((done as { error: string }).error).toContain('Error 404')
    expect(t.events.some(e => e.type === 'item_started' && e.item.kind === 'assistant')).toBe(false)
    await t.session.close()
  })

  it('接上原来的会话用 resume；接不上就新开并提示；档位按模型夹', async () => {
    const t = setup({ engineSessionId: 'gone', model: 'gemini-3.1-pro', effort: 'medium' })
    t.session.send('hi', 't1', 'u1')
    await t.turnDone('t1')
    expect(t.sent().map(m => m.method)).toContain('session/resume')
    expect(t.events.some(e => e.type === 'item_completed' && e.item.kind === 'notice' && e.item.level === 'warn')).toBe(
      true,
    )
    expect(t.rec()).toMatchObject({ engineSessionId: 's1', effort: 'low' })
    await t.session.close()
    const again = setup({ engineSessionId: 's1' })
    again.session.send('hi', 't1', 'u1')
    await again.turnDone('t1')
    expect(again.sent().map(m => m.method)).not.toContain('session/new')
    await again.session.close()
  })

  it('接上时超时、进程退出：这一轮报错，不新开、不换会话 id', async () => {
    const t = setup({ engineSessionId: 'crash' })
    t.session.send('hi', 't1', 'u1')
    const done = await t.turnDone('t1')
    // 进程退出时退出处理先结束这一轮（「进程退出了」）；超时走 startOnce 的「没有新开会话」
    expect(done).toMatchObject({ outcome: 'failed' })
    expect(t.sent().map(m => m.method)).not.toContain('session/new')
    expect(t.rec().engineSessionId).toBe('crash')
    expect(
      t.events.some(e => e.type === 'item_completed' && e.item.kind === 'notice' && e.item.text.includes('新会话')),
    ).toBe(false)
    await t.session.close()
  })

  it('会话不在了：新开，把之前的聊天放在这一轮消息前面，提示带上了', async () => {
    const t = setup({ engineSessionId: 'gone' })
    const asked: string[] = []
    Object.assign(t.ctx, {
      lostSeed: (userItemId: string) => {
        asked.push(userItemId)
        return {
          seed: { fallback: '【之前的聊天】你：改按钮', fallbackImages: [] },
          notice: { kind: 'notice', id: 'n1', level: 'warn', text: '已改开新会话，带上了之前的聊天' },
        }
      },
    })
    t.session.send('接着改颜色', 't1', 'u1')
    await t.turnDone('t1')
    expect(asked).toEqual(['u1'])
    const prompt = t.sent().find(m => m.method === 'session/prompt')!
    expect(prompt.params.prompt[0].text).toBe('【之前的聊天】你：改按钮\n\n接着改颜色')
    const notice = t.events.find(e => e.type === 'item_completed' && e.item.kind === 'notice') as {
      item: { text: string; detail?: string }
    }
    expect(notice.item).toMatchObject({ text: '已改开新会话，带上了之前的聊天', detail: 'not found' })
    expect(t.rec().engineSessionId).toBe('s1')
    // 只带一次
    t.session.send('再来', 't2', 'u2')
    await t.turnDone('t2')
    expect(asked).toEqual(['u1'])
    await t.session.close()
  })

  it('后台命令：顶条 tasks、读实时输出与端口、点停止杀子进程树并插已停止卡片', async () => {
    const taskLog = join(dir, 'task-76.log')
    writeFileSync(taskLog, 'VITE v6.3.5 ready\nLocal: http://localhost:5173/\n')
    const killed: number[] = []
    const alive = new Set([4242])
    const ops: AgyProcessOps = {
      findChild: async () => 4242,
      isAlive: pid => alive.has(pid),
      killTree: async pid => {
        killed.push(pid)
        alive.delete(pid)
      },
    }
    const t = setup({}, undefined, undefined, ops, 80, { FAKE_BG_LOG_URL: pathToFileURL(taskLog).href })
    t.session.send('bg:dev', 't1', 'u1')
    await t.turnDone('t1')

    const lastTasks = () =>
      (t.events.filter(e => e.type === 'tasks').at(-1) as Extract<EngineEvent, { type: 'tasks' }> | undefined)?.tasks
    expect(lastTasks()).toEqual([
      {
        id: 's1/task-76',
        kind: 'local_bash',
        description: 'pnpm dev',
        message: 'Local: http://localhost:5173/',
      },
    ])
    const out = await t.session.taskOutput('s1/task-76')
    expect(out).toEqual({ output: 'VITE v6.3.5 ready\nLocal: http://localhost:5173/', truncated: false })

    await t.session.stopTask('s1/task-76')
    expect(killed).toEqual([4242])
    expect(lastTasks()).toEqual([])
    expect(
      t.events.find(e => e.type === 'item_completed' && e.item.kind === 'command' && e.item.command === 'pnpm dev'),
    ).toMatchObject({
      item: { status: 'interrupted', background: false, output: 'VITE v6.3.5 ready\nLocal: http://localhost:5173/' },
    })
    expect(
      t.events.find(e => e.type === 'item_completed' && e.item.kind === 'notice' && e.item.task?.kind === 'bash'),
    ).toMatchObject({
      item: { task: { kind: 'bash', status: 'stopped', label: 'pnpm dev' } },
    })
    await t.session.close()
  })

  it('后台构建自然跑完：空闲巡检发现子进程退出后自动收起顶条并插已完成卡片', async () => {
    const taskLog = join(dir, 'task-77.log')
    writeFileSync(taskLog, 'building...\n')
    const alive = new Set([5151])
    const ops: AgyProcessOps = {
      findChild: async () => 5151,
      isAlive: pid => alive.has(pid),
      killTree: async () => {},
    }
    const t = setup({}, undefined, undefined, ops, 40, { FAKE_BG_LOG_URL: pathToFileURL(taskLog).href })
    t.session.send('bg:build', 't1', 'u1')
    await t.turnDone('t1')
    // 等待 bindPid 完成绑定后，模拟构建结束并退出
    await new Promise(r => setTimeout(r, 60))
    writeFileSync(taskLog, 'building...\nbuilt 24 chunks in 3.1s\n')
    alive.delete(5151)
    await new Promise<void>(resolve => {
      const wait = (): void => {
        const tasks = (t.events.filter(e => e.type === 'tasks').at(-1) as { tasks: unknown[] } | undefined)?.tasks
        if (tasks && tasks.length === 0) resolve()
        else setTimeout(wait, 25)
      }
      wait()
    })
    expect(
      t.events.find(e => e.type === 'item_completed' && e.item.kind === 'command' && e.item.command === 'pnpm build'),
    ).toMatchObject({
      item: { status: 'completed', background: false, output: 'building...\nbuilt 24 chunks in 3.1s' },
    })
    expect(
      t.events.find(e => e.type === 'item_completed' && e.item.kind === 'notice' && e.item.task?.kind === 'bash'),
    ).toMatchObject({
      item: {
        task: { kind: 'bash', status: 'completed', label: 'pnpm build', summary: 'built 24 chunks in 3.1s' },
      },
    })
    await t.session.close()
  })
})

describe('模型和档位', () => {
  it('档位：没有就取不超过它的最高一档', () => {
    expect(pickEffort('medium', ['low', 'high'])).toBe('low')
    expect(pickEffort('max', ['low', 'medium', 'high'])).toBe('high')
    expect(pickEffort('high', ['low', 'high'])).toBe('high')
    expect(pickEffort('low', [])).toBeNull()
  })
  it('session/new 的结果 → 模型目录，每个模型的档位来自组合 id', () => {
    const c = agyModels({
      configOptions: [
        {
          id: 'model',
          currentValue: 'gemini-3.1-pro',
          options: [
            { value: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
            { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
          ],
        },
        { id: 'thought_level', currentValue: 'low', options: [] },
      ],
      models: {
        availableModels: [
          'gemini-3.1-pro-high',
          'gemini-3.1-pro-low',
          'gemini-3.8-flash-high',
          'gemini-3.8-flash-medium',
          'gemini-3.8-flash-low',
        ].map(modelId => ({ modelId })),
      },
    })
    expect(c.currentModel).toBe('gemini-3.1-pro')
    expect(c.models).toEqual([
      expect.objectContaining({
        id: 'gemini-3.1-pro',
        efforts: ['low', 'high'],
        defaultEffort: 'low',
        isDefault: true,
      }),
      expect.objectContaining({
        id: 'gemini-3.8-flash',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: null,
        isDefault: false,
      }),
    ])
  })
})
