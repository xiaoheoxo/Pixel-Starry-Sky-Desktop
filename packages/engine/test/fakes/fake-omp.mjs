// 假的 oh-my-pi（omp --mode rpc）：测试用，照试验录到的帧（docs/omp-engine-trial.md §3）。
// 环境变量：FAKE_OMP_LOG 记录收到的每条命令；FAKE_OMP_ARGV 记录启动参数；FAKE_OMP_DIR 放会话文件。
// 提示词关键字：「工具」→ bash 确认（omp 的英文三选一）；「慢」→ 等 abort；「大」→ 回复超过 1 MiB，按第 2 版拆成 rpc_chunk；
// 「坏」→ prompt_result status: error；「派活」→ task 一次派两个子智能体；「后台分」→ task 派两个到后台，工具先返回、之后跑完（含「取消」→ 一个被停，含「停」→ 主轮停了才跑完）；「并发」→ 派两个、同时只跑一个，等着被停；FAKE_OMP_STUCK_AGENTS=1 停不掉；「占用」→ 会话改存到新文件并报警告；「悄悄换」→ 不报就换文件；会话文件是一棵树（navigate_tree、new_session、/pixelsky-turn），每轮在 FAKE_OMP_LOG 记 { type: 'context', users }；「计划」（加载了计划扩展时）→ 计划卡，批准后报回到的档。btw：问题含「旁聊失败」→ status error；含「旁聊慢」→ 等 btw_cancel；
// 否则回答「旁聊回答：<进程 pid>，<模型>，问：<问题末尾>」
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'

if (process.env.FAKE_OMP_ARGV)
  appendFileSync(
    process.env.FAKE_OMP_ARGV,
    JSON.stringify({
      argv: process.argv.slice(2),
      token: process.env.PIXELSKY_PIXEL_TOKEN ?? null,
      providers: process.env.PIXELSKY_PIXEL_PROVIDERS ? JSON.parse(process.env.PIXELSKY_PIXEL_PROVIDERS) : null,
      inferred: process.env.PIXELSKY_PIXEL_INFERRED ?? null,
      plan: process.env.PIXELSKY_OMP_PLAN ?? null,
      head: process.argv.includes('--session')
        ? readFileSync(process.argv[process.argv.indexOf('--session') + 1], 'utf8')
        : null,
    }) + '\n',
  )
if (process.argv.includes('--version')) {
  process.stdout.write('omp/19.1.0\n')
  process.exit(0)
}
// omp --export <会话文件> <输出>：FAKE_OMP_EXPORT_FAIL=1 报错退出
if (process.argv.includes('--export')) {
  const [file, target] = process.argv.slice(process.argv.indexOf('--export') + 1)
  if (process.env.FAKE_OMP_EXPORT_FAIL) {
    process.stderr.write('Error: bad session\n')
    process.exit(1)
  }
  writeFileSync(target, `<html>${readFileSync(file, 'utf8').length}</html>`)
  process.exit(0)
}
const dir = process.env.FAKE_OMP_DIR ?? process.cwd()
mkdirSync(dir, { recursive: true })
const CHUNK = 1024 * 1024
let protocol = 1
const out = value => {
  const line = JSON.stringify(value)
  if (protocol < 2 || Buffer.byteLength(line) <= CHUNK) return void process.stdout.write(line + '\n')
  const bytes = Buffer.from(line, 'utf8'),
    count = Math.ceil(bytes.length / CHUNK),
    chunkId = `c${Date.now()}`
  for (let index = 0; index < count; index++)
    process.stdout.write(
      JSON.stringify({
        type: 'rpc_chunk',
        chunkId,
        index,
        count,
        byteLength: bytes.length,
        data: bytes.subarray(index * CHUNK, (index + 1) * CHUNK).toString('base64'),
      }) + '\n',
    )
}
/** 在跑的子智能体 → 停它 */
const live = new Map()
// 真 omp 19.1.1 的 /context 输出（进度条缩短了）
const CONTEXT = [
  'Context window: 200000 tokens (11% used)',
  '  System prompt    [\u001b[38;5;243m░░\u001b[39m\u001b[1m░\u001b[22m] 1%  1731 tokens',
  '  System tools     [█░░] 2%  4397 tokens',
  '  System context   [░░░] 0%  451 tokens',
  '  Instruction files [░░░] 2%  3207 tokens',
  '  Skills           [░░░] 0%  7 tokens',
  '  Messages         [█░░] 6%  12028 tokens',
  '  Auto-compact buf [█░░] 15%  30000 tokens',
  '  Free             [██░] 74%  148179 tokens',
  'Snapcompact: inactive (model has no image input)',
].join('\n')
const SESSION_ID = '01a2070e-7df1-70f9-9687-f0bd83d92fbc'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const models = [
  {
    provider: 'fake',
    id: 'fake-omp',
    name: 'Fake omp',
    reasoning: true,
    thinking: { mode: 'anthropic-adaptive', efforts: ['low', 'medium', 'high'] },
    input: ['text'],
    contextWindow: 200000,
  },
  {
    provider: 'fake',
    id: 'fake-omp-2',
    name: 'Fake omp 2',
    reasoning: true,
    thinking: { mode: 'effort', efforts: ['minimal', 'low', 'high', 'xhigh', 'max'] },
    input: ['text'],
    contextWindow: 200000,
  },
  // 推理但不能调档（真 omp 的 grok-4）
  {
    provider: 'fake',
    id: 'fake-omp-fixed',
    name: 'Fake omp fixed',
    reasoning: true,
    input: ['text'],
    contextWindow: 200000,
  },
]
for (const [provider, config] of Object.entries(
  process.env.PIXELSKY_PIXEL_PROVIDERS ? JSON.parse(process.env.PIXELSKY_PIXEL_PROVIDERS) : {},
))
  for (const m of config.models ?? []) models.push({ provider, name: m.id, contextWindow: 128000, ...m })
// FAKE_OMP_FAST=1：一开始就是 Fast 档（像用户配置里写了 tier.openai: priority）；FAKE_OMP_FAST_STUCK=1：关不掉。
// FAKE_OMP_FAST_NO=<模型 id>：这个模型开了也不生效（active: false，像平台 Messages 线路上的 Claude）。
// 每次 prompt 记下当时的档位（FAKE_OMP_LOG 里 prompt 那行之后追加 {type:'tier', fast}）
let fast = process.env.FAKE_OMP_FAST === '1'
const fastActive = () => fast && process.env.FAKE_OMP_FAST_NO !== model.id
let turning = false
let model = models[0],
  sessionFile = join(dir, `omp-${process.pid}.jsonl`),
  approval = null,
  aborter = null,
  tools = 0,
  btwCancel = null,
  btwInput = 0
const response = (m, data) =>
  out({ id: m.id, type: 'response', command: m.type, success: true, ...(data === undefined ? {} : { data }) })
const fail = (m, error) => out({ id: m.id, type: 'response', command: m.type, success: false, error })
const assistant = content => ({ role: 'assistant', content, provider: 'fake', model: model.id, stopReason: 'stop' })

// 会话文件：一棵只追加的树（条目有 id、parentId，leaf 是当前位置；重新打开时从最后一条接着）
let rows = [],
  leaf = null,
  head = { type: 'session', version: 3, id: SESSION_ID, cwd: process.cwd() }
const append = row => {
  const { type, ...rest } = row
  const id = `${process.pid}x${rows.length}`
  const base = { id, parentId: leaf, timestamp: '2026-11-23T06:41:46.541Z' }
  // 真 omp：消息条目 id 在前，自定义条目 id 在正文后面
  rows.push(type === 'message' ? { type, ...base, ...rest } : { type, ...rest, ...base })
  leaf = id
}
const path = () => {
  const out = []
  for (let r = rows.find(x => x.id === leaf); r; r = rows.find(x => x.id === r.parentId)) out.unshift(r)
  return out
}
const cwdOf = file =>
  readFileSync(file, 'utf8')
    .split('\n')
    .flatMap(l => (l.startsWith('{"type":"session"') ? [JSON.parse(l).cwd] : []))[0]
const loadFile = file => {
  if (!existsSync(file)) return
  const lines = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  head = lines.find(l => l.type === 'session') ?? head
  rows = lines.filter(l => l.type !== 'session' && l.type !== 'title')
  leaf = rows.at(-1)?.id ?? null
}
const resumed = process.argv.includes('--session') ? process.argv[process.argv.indexOf('--session') + 1] : null
if (resumed) {
  loadFile(resumed)
  // 旁聊的副本只读内容
  if (existsSync(resumed)) sessionFile = resumed
}
const message = (role, text) =>
  append({ type: 'message', message: { role, content: [{ type: 'text', text }], provider: 'fake', model: model.id } })
const save = () =>
  writeFileSync(
    sessionFile,
    [{ type: 'title', title: '会话' }, head, ...rows].map(l => JSON.stringify(l) + '\n').join(''),
  )

// 目标（真 omp 的时序）：一次接一次地跑，做到「做 N 次」完成；用户消息的 prompt_result 在下一次的 agent_start 之后才到。
// 文件里是进行中的：--session 打开读成暂停的，switch_session 切过去马上接着做
let goal = null,
  goalRuns = 0,
  goalRunning = false
const steered = []
const journal = () => {
  append({
    type: 'mode_change',
    mode: !goal ? 'none' : goal.status === 'active' ? 'goal' : 'goal_paused',
    ...(goal ? { data: { goal: { ...goal } } } : {}),
  })
  if (existsSync(sessionFile)) save()
}
const goalEvent = (g = goal) => out({ type: 'goal_updated', goal: g })
const restoreGoal = starting => {
  const row = path().findLast(x => x.type === 'mode_change')
  goal = row?.data?.goal ? { ...row.data.goal } : null
  if (goal?.status !== 'active') return
  if (starting) goal.status = 'paused'
  else void goalLoop([])
}
async function goalLoop(results) {
  if (goalRunning) return
  goalRunning = true
  const flush = sessionSettled => {
    for (const r of results.splice(0)) out({ ...r, sessionSettled })
  }
  while (goal?.status === 'active') {
    out({ type: 'agent_start' })
    flush(false)
    for (const customType of ['goal-mode-context', 'goal-continuation'])
      out({ type: 'message_start', message: { role: 'custom', customType, content: 'x' } })
    await sleep(goal.objective.includes('慢') ? 60 : 5)
    if (goal?.status === 'active') {
      goal.tokensUsed += 10
      goal.updatedAt++
      goalEvent()
      await say(`目标第 ${++goalRuns} 次`)
      for (let m = steered.shift(); m; m = steered.shift()) {
        message('user', String(m.message))
        out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: m.message }] } })
        await say(`收到：${m.message}`)
        results.push({ type: 'prompt_result', id: m.id, agentInvoked: true, status: 'completed' })
      }
    }
    if (goal?.status === 'active' && goalRuns >= Number(/做 (\d+) 次/.exec(goal.objective)?.[1] ?? 99)) {
      goalEvent({ ...goal, status: 'complete' })
      goal = null
      journal()
    }
    save()
    out({ type: 'agent_end' })
    // 没有进展：停下，目标还是进行中
    if (goal?.objective.includes('没进展')) break
  }
  goalRunning = false
  flush(true)
  out({ type: 'session_settled' })
}

async function say(content) {
  message('assistant', content.slice(0, 200))
  out({ type: 'message_start', message: assistant([]) })
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: content } })
  out({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content } })
  out({ type: 'message_end', message: assistant([{ type: 'text', text: content }]) })
}

async function turn(m) {
  message('user', String(m.message))
  // 关键字只看用户自己的话：前面拼的交接材料里什么词都有
  const text = String(m.message).split('</pixelsky-handoff>').pop()
  // 这一轮发出去时上下文里的用户消息
  if (process.env.FAKE_OMP_LOG)
    appendFileSync(
      process.env.FAKE_OMP_LOG,
      JSON.stringify({
        type: 'context',
        users: path().flatMap(r => (r.message?.role === 'user' ? [r.message.content[0].text] : [])),
      }) + '\n',
    )
  out({ type: 'agent_start' })
  out({ type: 'turn_start' })
  out({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }] } })
  out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } })
  let status = 'completed',
    error
  if (text.includes('工具')) {
    const toolCallId = `call-${++tools}`
    out({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args: { command: 'echo hi' } })
    const id = `ui-${tools}`
    out({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title: 'Allow tool: bash\nCommand: echo hi',
      options: ['Approve', 'Approve bash for this session', 'Deny'],
    })
    const value = await new Promise(resolve => (approval = { id, resolve }))
    const denied = value === 'Deny'
    out({
      type: 'tool_execution_end',
      toolCallId,
      toolName: 'bash',
      isError: denied,
      result: { content: [{ type: 'text', text: denied ? 'Tool call denied by user: bash' : 'hi' }] },
    })
    await say(`选了 ${value}`)
  } else if (text.includes('派活')) {
    // omp 的 task：一次派两个子智能体，进度里是各自的 progress，结束时是 results（一个成功、一个失败）
    const toolCallId = 'call-task'
    const base = { agent: 'task', agentSource: 'bundled', recentTools: [], recentOutput: [], requests: 1, cost: 0 }
    out({
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'task',
      args: {
        tasks: [
          { name: 'a', task: '查 A' },
          { name: 'b', task: '查 B' },
        ],
      },
    })
    out({
      type: 'tool_execution_update',
      toolCallId,
      toolName: 'task',
      partialResult: {
        content: [],
        details: {
          projectAgentsDir: null,
          results: [],
          totalDurationMs: 0,
          progress: [
            {
              ...base,
              index: 0,
              id: '0-a',
              status: 'running',
              description: 'a',
              task: '查 A',
              toolCount: 2,
              tokens: 50,
              durationMs: 10,
              currentTool: 'read',
            },
            {
              ...base,
              index: 1,
              id: '1-b',
              status: 'pending',
              description: 'b',
              task: '查 B',
              toolCount: 0,
              tokens: 0,
              durationMs: 0,
            },
          ],
        },
      },
    })
    await sleep(5)
    out({
      type: 'tool_execution_end',
      toolCallId,
      toolName: 'task',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'done' }],
        details: {
          projectAgentsDir: null,
          totalDurationMs: 30,
          results: [
            {
              index: 0,
              id: '0-a',
              agent: 'task',
              description: 'a',
              task: '查 A',
              exitCode: 0,
              output: 'A 的结果',
              stderr: '',
              truncated: false,
              durationMs: 20,
              tokens: 80,
              requests: 2,
              resolvedModel: 'fake/fake-omp:high',
            },
            {
              index: 1,
              id: '1-b',
              agent: 'task',
              description: 'b',
              task: '查 B',
              exitCode: 1,
              output: '',
              stderr: '',
              error: 'B 失败了',
              truncated: false,
              durationMs: 5,
              tokens: 10,
              requests: 1,
            },
          ],
        },
      },
    })
    await say('派完了')
  } else if (text.includes('计划') && process.env.PIXELSKY_OMP_PLAN === '1') {
    // 计划扩展加载时：exit_plan_mode 的对话框比它的 tool_execution_start 先到（实测 omp 的顺序）
    const toolCallId = 'call-plan'
    const id = 'ui-plan'
    out({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title: '计划已就绪，要开始执行吗？ / Ready to implement this plan?\n# 计划\n1. 改 a',
      options: ['开始执行 / Start implementing', '继续完善计划 / Keep planning'],
    })
    out({ type: 'tool_execution_start', toolCallId, toolName: 'exit_plan_mode', args: { plan: '# 计划\n1. 改 a' } })
    const value = await new Promise(resolve => (approval = { id, resolve }))
    const approved = value === '开始执行 / Start implementing'
    if (approved)
      out({
        type: 'extension_ui_request',
        id: 'ui-status',
        method: 'setStatus',
        statusKey: 'pixelsky-mode',
        statusText: process.env.PIXELSKY_OMP_PLAN_RETURN || 'default',
      })
    out({
      type: 'tool_execution_end',
      toolCallId,
      toolName: 'exit_plan_mode',
      isError: false,
      result: { content: [{ type: 'text', text: approved ? 'approved' : 'keep refining' }], details: {} },
    })
    await say(approved ? '开始做' : '再想想')
  } else if (text.includes('后台分')) {
    // 真 omp 的派活：工具马上返回（details.async），子智能体在后台跑，跑完再报 update 和 async-result；
    // 「停」：主轮被停以后子智能体才跑完
    const toolCallId = `call-bg-${++tools}`
    const agents = ['Alpha', 'Beta']
    const progress = status =>
      agents.map((id, index) => ({
        index,
        id,
        agent: 'task',
        status: id === 'Beta' && status === 'completed' && text.includes('取消') ? 'aborted' : status,
        assignment: `查 ${id}`,
        recentOutput: [],
        toolCount: 1,
        tokens: 110,
        durationMs: 20,
        resolvedModel: 'fake/fake-omp:high',
      }))
    const details = (status, extra = {}) => ({
      projectAgentsDir: null,
      results: [],
      totalDurationMs: 1,
      progress: progress(status),
      ...extra,
    })
    const update = status =>
      out({
        type: 'tool_execution_update',
        toolCallId,
        toolName: 'task',
        partialResult: { content: [], details: details(status) },
      })
    out({
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'task',
      args: { tasks: agents.map(name => ({ name, task: `查 ${name}` })) },
    })
    update('running')
    const result = {
      content: [{ type: 'text', text: 'Spawned 2 background agents' }],
      details: details('pending', { async: { state: 'running', jobId: 'Alpha', type: 'task' } }),
    }
    out({ type: 'tool_execution_end', toolCallId, toolName: 'task', isError: false, result })
    update('running')
    append({
      type: 'message',
      message: { role: 'toolResult', toolCallId, toolName: 'task', ...result, isError: false },
    })
    const finish = () => {
      const folder = sessionFile.replace(/\.jsonl$/, '')
      mkdirSync(folder, { recursive: true })
      for (const id of agents) {
        const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } }
        const content = [{ type: 'text', text: `${id} 查完了` }]
        const call = [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.txt' } }]
        writeFileSync(
          join(folder, `${id}.jsonl`),
          [
            { type: 'title', title: '' },
            { type: 'session', version: 3, id, parentSession: sessionFile },
            { type: 'message', id: 'm1', message: { role: 'user', content: [{ type: 'text', text: `查 ${id}` }] } },
            { type: 'message', id: 'm2', message: { role: 'assistant', content: call, model: 'fake-omp' } },
            {
              type: 'message',
              id: 'm3',
              message: {
                role: 'toolResult',
                toolCallId: 'c1',
                toolName: 'read',
                content: [{ type: 'text', text: 'ok' }],
              },
            },
            { type: 'message', id: 'm4', message: { role: 'assistant', content, usage, model: 'fake-omp' } },
          ]
            .map(l => JSON.stringify(l) + '\n')
            .join(''),
        )
        const status = id === 'Beta' && text.includes('取消') ? 'cancelled' : 'completed'
        const body = status === 'completed' ? `<output>\n${id} 的结果\n</output>` : '<abort-reason>停了</abort-reason>'
        append({
          type: 'custom_message',
          customType: 'async-result',
          content: `<system-notice>\n<task-result id="${id}" agent="task" status="${status}">\n\n${body}\n</task-result>\n</system-notice>`,
          details: { jobs: [{ jobId: id, type: 'task', status, agentId: id, label: id, durationMs: 1400 }] },
        })
      }
      update('completed')
    }
    if (text.includes('停')) {
      await new Promise(resolve => (aborter = resolve))
      status = 'aborted'
      setTimeout(() => {
        finish()
        save()
      }, 150)
    } else {
      await say('派出去了')
      finish()
    }
  } else if (text.includes('并发')) {
    // 派两个到后台、同时只跑一个：cancel_subagent 停掉在跑的，排队的补上来；主轮被停时照样报 completed（真 omp 在等子智能体时就这样）
    const toolCallId = `call-par-${++tools}`
    const states = { Alpha: 'running', Beta: 'pending' }
    const details = () => ({
      results: [],
      totalDurationMs: 1,
      progress: Object.entries(states).map(([id, s]) => ({ id, agent: 'task', status: s, assignment: id })),
    })
    const update = () =>
      out({ type: 'tool_execution_update', toolCallId, toolName: 'task', partialResult: { details: details() } })
    const begin = id => {
      states[id] = 'running'
      live.set(id, () => {
        live.delete(id)
        states[id] = 'aborted'
        if (states.Beta === 'pending') begin('Beta')
        update()
      })
    }
    out({
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'task',
      args: { tasks: [{ name: 'Alpha' }, { name: 'Beta' }] },
    })
    begin('Alpha')
    const result = {
      content: [{ type: 'text', text: 'Spawned' }],
      details: { ...details(), async: { state: 'running' } },
    }
    out({ type: 'tool_execution_end', toolCallId, toolName: 'task', isError: false, result })
    update()
    await new Promise(resolve => (aborter = resolve))
  } else if (text.includes('占用')) {
    // 会话文件被别的 omp 进程占着：改存到新文件，报一条警告（会重放）
    const from = sessionFile
    sessionFile = join(dir, `moved-${process.pid}.jsonl`)
    const notice = `Session ${from} is open for writing in another omp process, so this session now saves to ${sessionFile} instead of mixing its entries into that file.`
    for (let i = 0; i < 2; i++)
      out({ type: 'notice', level: 'warning', message: notice, source: 'session-persistence' })
    await say('换了文件')
  } else if (text.includes('悄悄换')) {
    // 没有通知就换了（用户发 /new 之类）
    sessionFile = join(dir, `new-${process.pid}.jsonl`)
    await say('换了文件')
  } else if (text.includes('慢')) {
    await new Promise(resolve => (aborter = resolve))
    status = 'aborted'
  } else if (text.includes('大')) {
    await say('x'.repeat(CHUNK + 1000))
  } else if (text.includes('坏')) {
    status = 'error'
    error = { message: 'boom from omp' }
  } else await say('好的')
  save()
  out({ type: 'turn_end' })
  out({ type: 'agent_end' })
  const result = { type: 'prompt_result', id: m.id, agentInvoked: true, status, ...(error ? { error } : {}) }
  if (goal?.status === 'active') return void goalLoop([result])
  out({ ...result, sessionSettled: true })
  out({ type: 'session_settled' })
}
if (resumed) restoreGoal(true)

out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: CHUNK })
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async line => {
  const m = JSON.parse(line)
  if (process.env.FAKE_OMP_LOG) appendFileSync(process.env.FAKE_OMP_LOG, line + '\n')
  switch (m.type) {
    case 'negotiate_protocol':
      protocol = m.protocolVersion
      return response(m, { protocolVersion: protocol })
    case 'get_state':
      return response(m, {
        sessionId: `id-${process.pid}`,
        sessionFile,
        model,
        thinkingLevel: 'medium',
        fastModeEnabled: fast,
        fastModeActive: fastActive(),
        // FAKE_OMP_NO_TASK=1：像用户用 --tools 关掉了 task
        dumpTools: ['read', 'bash', ...(process.env.FAKE_OMP_NO_TASK === '1' ? [] : ['task'])].map(name => ({ name })),
      })
    case 'switch_session':
      // 文件头里的工作目录对不上就拒绝，盘符大小写也算（真 omp 这样）
      if (cwdOf(m.sessionPath) !== process.cwd()) return response(m, { cancelled: true })
      sessionFile = m.sessionPath
      loadFile(sessionFile)
      restoreGoal(false)
      return response(m, { cancelled: false })
    case 'goal': {
      if (process.env.FAKE_OMP_NO_GOAL) return fail(m, 'unknown command goal')
      const reply = () => response(m, { goal, state: null })
      if (m.op === 'get') return reply()
      if (m.op === 'create') {
        if (goal) return fail(m, 'A goal already exists')
        goal = { id: 'g', objective: m.objective, status: 'active', tokensUsed: 0, timeUsedSeconds: 0, updatedAt: 1000 }
        goalRuns = 0
      } else if (!goal) return fail(m, 'No goal')
      else if (m.op === 'drop') {
        goalEvent({ ...goal, status: 'dropped' })
        goal = null
        journal()
        return reply()
      } else goal.status = m.op === 'pause' ? 'paused' : 'active'
      goal.updatedAt++
      journal()
      goalEvent()
      reply()
      if (goal.status === 'active' && !aborter && !turning) void goalLoop([])
      return
    }
    case 'navigate_tree': {
      const row = rows.find(r => r.id === m.entryId)
      if (!row) return fail(m, `Entry ${m.entryId} not found`)
      leaf = row.message?.role === 'user' ? row.parentId : row.id
      return response(m, { cancelled: false })
    }
    case 'new_session':
      sessionFile = join(dir, `fresh-${process.pid}.jsonl`)
      rows = []
      leaf = null
      head = { ...head, id: `${process.pid}-fresh` }
      save()
      return response(m, { cancelled: false })
    case 'get_available_models':
      return response(m, { models })
    case 'set_model': {
      const found = models.find(x => x.provider === m.provider && x.id === m.modelId)
      if (!found) return fail(m, 'model not found')
      model = found
      // 档位按模型家族记：FAKE_OMP_FAST_ON_SWITCH=1 时换模型后又回到 Fast（像另一家写了 tier: priority）
      if (process.env.FAKE_OMP_FAST_ON_SWITCH === '1') fast = true
      return response(m, model)
    }
    case 'set_fast_mode':
      if (process.env.FAKE_OMP_FAST_STUCK !== '1') fast = m.enabled === true
      return response(m, { enabled: fast, active: fastActive() })
    case 'set_thinking_level':
      return response(m)
    case 'get_available_thinking_levels':
      return response(m, { levels: ['off', ...(model.thinking?.efforts ?? [])] })
    case 'get_session_stats':
      return response(m, {
        tokens: { input: btwInput, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        contextUsage: { tokens: 321 },
      })
    case 'compact':
    case 'handoff': {
      // 要求里含「太小」→ 没东西可压；「写坏」→ 文档不合格式；「慢」→ 等 abort
      const want = String(m.customInstructions ?? '')
      out({ type: 'manual_compaction_start', ...(m.type === 'handoff' ? { mode: 'handoff' } : {}) })
      const end = extra => out({ type: 'manual_compaction_end', aborted: false, ...extra })
      if (want.includes('慢')) {
        await new Promise(resolve => (aborter = resolve))
        end({ aborted: true, errorMessage: 'Compaction cancelled' })
        return fail(m, 'Compaction cancelled')
      }
      const bad = want.includes('太小')
        ? 'Nothing to compact (session too small)'
        : want.includes('写坏')
          ? 'Handoff generation produced an invalid document'
          : ''
      if (bad) {
        end({ errorMessage: bad, ...(want.includes('太小') ? { skipped: true } : {}) })
        return fail(m, bad)
      }
      const summary = `## Goal\n${want}`
      append({
        type: 'compaction',
        summary,
        tokensBefore: 900,
        tokensAfter: 321,
        ...(m.type === 'handoff' ? { method: 'handoff' } : {}),
      })
      save()
      end({ result: { summary, firstKeptEntryId: 'x', tokensBefore: 900 } })
      return response(m, m.type === 'handoff' ? {} : { summary })
    }
    case 'get_available_commands':
      return response(m, {
        commands: [
          { name: 'security', description: 'Security scans' },
          { name: 'compact', description: 'Compact', source: 'builtin' },
          { name: 'handoff', description: 'Handoff', source: 'builtin' },
          // FAKE_OMP_CONTEXT：有自带的 /context；值是 bad 时输出认不出的格式
          ...(process.env.FAKE_OMP_CONTEXT ? [{ name: 'context', description: 'Context', source: 'builtin' }] : []),
          // FAKE_OMP_NO_TURN=1：像用户的参数关掉了扩展
          ...(process.env.FAKE_OMP_NO_TURN ? [] : [{ name: 'pixelsky-turn', description: 'x', source: 'extension' }]),
        ],
      })
    case 'prompt':
      // 扩展命令：记一条自定义条目；回应里没有 agentInvoked，做完另报一条 prompt_result（实测）
      if (String(m.message).startsWith('/pixelsky-turn')) {
        append({ type: 'custom', customType: 'pixelsky.turn', data: { id: String(m.message).slice(15) } })
        if (existsSync(sessionFile)) save()
        response(m, {})
        return out({ type: 'prompt_result', id: m.id, agentInvoked: false, status: 'completed', sessionSettled: true })
      }
      if (process.env.FAKE_OMP_LOG)
        appendFileSync(process.env.FAKE_OMP_LOG, JSON.stringify({ type: 'tier', fast: fastActive() }) + '\n')
      // 输出在应答之前；mixed 夹一条别的内置命令的输出（用户同时跑的）
      if (m.message === '/context' && process.env.FAKE_OMP_CONTEXT) {
        if (process.env.FAKE_OMP_CONTEXT === 'mixed') out({ type: 'command_output', text: '别的输出' })
        out({ type: 'command_output', text: process.env.FAKE_OMP_CONTEXT === 'bad' ? 'Ctx 5%' : CONTEXT })
        return response(m, { agentInvoked: false })
      }
      if (String(m.message).startsWith('/security')) return response(m, { agentInvoked: false })
      if (String(m.message).startsWith('/usage')) {
        out({ type: 'command_output', text: 'Usage\n\u001b[1mTotal\u001b[22m: 0' })
        return response(m, { agentInvoked: false })
      }
      response(m, { agentInvoked: true })
      if (goalRunning) return void steered.push(m)
      turning = true
      return void turn(m).finally(() => (turning = false))
    case 'extension_ui_response':
      if (approval?.id === m.id) {
        const a = approval
        approval = null
        a.resolve(m.cancelled ? 'Deny' : m.value)
      }
      return
    case 'btw': {
      const question = String(m.question)
      const record = { id: 'btw-1', leafId: null, question, answer: '', status: 'running', createdAt: 1, updatedAt: 1 }
      // 实测：running 那一帧比回应先到
      out({ type: 'btw_record', record })
      response(m, { record })
      if (question.includes('旁聊慢'))
        return void (btwCancel = () => out({ type: 'btw_record', record: { ...record, status: 'cancelled' } }))
      await sleep(5)
      if (question.includes('旁聊失败'))
        return out({ type: 'btw_record', record: { ...record, status: 'error', error: 'btw boom' } })
      const answer = `旁聊回答：${process.pid}，${model.provider}/${model.id}，问：${question.slice(-12)}`
      btwInput += 100
      out({ type: 'btw_delta', recordId: 'btw-1', delta: answer })
      return out({ type: 'btw_record', record: { ...record, status: 'complete', answer } })
    }
    case 'btw_cancel':
      btwCancel?.()
      btwCancel = null
      return response(m, { cancelled: true })
    case 'get_subagents':
      return response(m, { subagents: [...live.keys()].map(id => ({ id, status: 'running' })) })
    case 'cancel_subagent': {
      const cancel = process.env.FAKE_OMP_STUCK_AGENTS ? null : live.get(m.subagentId)
      cancel?.()
      return response(m, { cancelled: !!cancel })
    }
    case 'abort':
      if (goal?.status === 'active') {
        goal.status = 'paused'
        goal.updatedAt++
        journal()
        goalEvent()
      }
      aborter?.()
      aborter = null
      await sleep(5)
      return response(m)
    default:
      return fail(m, `unknown command ${m.type}`)
  }
})
rl.on('close', () => process.exit(0))
