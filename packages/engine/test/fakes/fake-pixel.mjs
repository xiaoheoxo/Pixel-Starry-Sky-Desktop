// 假的像素星空命令行（Pi RPC 协议）：测试用。按提示词里的关键字走不同的剧本。
// 环境变量：FAKE_PIXEL_LOG 记录收到的每条命令；FAKE_PIXEL_DIR 放会话文件；FAKE_PIXEL_ARGV 记录启动参数。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'

if (process.env.FAKE_PIXEL_ARGV)
  appendFileSync(
    process.env.FAKE_PIXEL_ARGV,
    JSON.stringify({
      argv: process.argv.slice(2),
      agentDir: process.env.PIXELSKY_CODING_AGENT_DIR ?? null,
      electron: process.env.ELECTRON_RUN_AS_NODE ?? null,
      token: process.env.PIXELSKY_PIXEL_TOKEN ?? null,
      anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
      providers: process.env.PIXELSKY_PIXEL_PROVIDERS ? JSON.parse(process.env.PIXELSKY_PIXEL_PROVIDERS) : null,
      mcpFile: process.env.PIXELSKY_MCP_FILE ?? null,
      allowTools: process.env.PIXELSKY_ALLOW_TOOLS ?? null,
      path: process.env.PATH ?? null,
    }) + '\n',
  )
if (process.argv.includes('--version')) {
  process.stdout.write('1.2.0\n')
  process.exit(0)
}
// -p：旁聊（pixel/side.ts）。从 stdin 读问题，读 --session 指向的会话文件（副本），往副本里追加一行（像真 Pi 一样写会话），
// 回答里写明看到了几行、问题是什么、工具开没开；问题里有「旁聊失败」时报错退出
if (process.argv.includes('-p')) {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const file = process.argv[process.argv.indexOf('--session') + 1]
  const lines = readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean).length
  appendFileSync(
    file,
    JSON.stringify({ type: 'message', message: { role: 'user', content: input } }) + String.fromCharCode(10),
  )
  if (input.includes('旁聊失败')) {
    process.stderr.write('Error: side boom' + String.fromCharCode(10))
    process.exit(1)
  }
  const tools = process.argv.includes('--no-tools') ? 'no-tools' : 'tools'
  const question = input.trim().split(String.fromCharCode(10)).at(-1)
  process.stdout.write(`旁聊回答：${lines} 行，${tools}，问：${question}` + String.fromCharCode(10))
  process.exit(0)
}
// FAKE_PIXEL_START_FAIL：起不来（报错退出），用来测启动错误
if (process.env.FAKE_PIXEL_START_FAIL) {
  process.stderr.write('Error: ' + process.env.FAKE_PIXEL_START_FAIL + '\n')
  process.exit(1)
}
const dir = process.env.FAKE_PIXEL_DIR ?? process.cwd()
mkdirSync(dir, { recursive: true })
const out = value => process.stdout.write(JSON.stringify(value) + '\n')
/** 批准扩展三选一的选项原文 */
const APPROVAL = ['允许 / Allow', '本会话不再询问 / Always allow in this session', '拒绝 / Deny']
const sleep = ms => new Promise(r => setTimeout(r, ms))
const models = [
  {
    provider: 'fake',
    id: 'fake-pixel',
    name: 'Fake Pixel',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 200000,
    thinkingLevelMap: { xhigh: 'xhigh' },
  },
  { provider: 'fake', id: 'fake-small', name: 'Fake Small', reasoning: false, input: ['text'], contextWindow: 32000 },
]
if (process.env.FAKE_PIXEL_SPEED)
  Object.assign(models[0], { api: 'openai-responses', serviceTiers: ['priority', 'ultrafast'] })
// 网关扩展注册的 provider（PIXELSKY_PIXEL_PROVIDERS）也列进来，没写窗口按 Pi 的默认 128K
for (const [provider, config] of Object.entries(
  process.env.PIXELSKY_PIXEL_PROVIDERS ? JSON.parse(process.env.PIXELSKY_PIXEL_PROVIDERS) : {},
))
  for (const m of config.models ?? [])
    models.push({ provider, name: m.id, reasoning: false, input: ['text'], contextWindow: 128000, ...m })
let model = models[0],
  thinkingLevel = 'medium',
  sessionNo = 1,
  sessionFile = join(dir, `session-${process.pid}.jsonl`),
  running = null,
  tools = 0,
  messages = 0,
  approval = null,
  steerWaiter = null,
  /** 在等的自动重试：abort / abort_retry 时调用，取消等待 */
  retryWaiter = null
/** Pi 的思考级别和夹紧规则（pi-ai models.js getSupportedThinkingLevels / clampThinkingLevel） */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const supportedLevels = m =>
  !m.reasoning
    ? ['off']
    : LEVELS.filter(level => {
        const mapped = m.thinkingLevelMap?.[level]
        if (mapped === null) return false
        return level === 'xhigh' || level === 'max' ? mapped !== undefined : true
      })
function clampLevel(m, level) {
  const available = supportedLevels(m)
  if (available.includes(level)) return level
  const at = LEVELS.indexOf(level)
  for (let i = at; i < LEVELS.length; i++) if (available.includes(LEVELS[i])) return LEVELS[i]
  for (let i = at - 1; i >= 0; i--) if (available.includes(LEVELS[i])) return LEVELS[i]
  return available[0] ?? 'off'
}
/** 和 Pi 的 setThinkingLevel 一样：按当前模型夹紧，变了才报 thinking_level_changed */
function setLevel(level) {
  const next = clampLevel(model, level)
  if (next === thinkingLevel) return
  thinkingLevel = next
  out({ type: 'thinking_level_changed', level: next })
}
const usage = (input, output) => ({
  input,
  output,
  cacheRead: 40,
  cacheWrite: 0,
  totalTokens: input + output + 40,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
})
const assistant = (content, extra = {}) => ({
  role: 'assistant',
  content,
  api: 'anthropic-messages',
  provider: 'fake',
  model: model.id,
  usage: usage(100, 20),
  stopReason: 'stop',
  timestamp: Date.now(),
  ...extra,
})
const update = (usageValue, assistantMessageEvent) =>
  out({ type: 'message_update', usage: usageValue, assistantMessageEvent })
const response = (m, data) =>
  out({ id: m.id, type: 'response', command: m.type, success: true, ...(data === undefined ? {} : { data }) })
const fail = (m, error) => out({ id: m.id, type: 'response', command: m.type, success: false, error })

function persist() {
  writeFileSync(sessionFile, '{"type":"session"}\n')
}
async function text(content, final = false) {
  out({ type: 'message_start', message: assistant([]) })
  update(usage(0, 0), { type: 'text_start', contentIndex: 0 })
  for (const part of [content.slice(0, 3), content.slice(3)]) {
    if (part) update(usage(100, 5), { type: 'text_delta', contentIndex: 0, delta: part })
    await sleep(5)
  }
  update(usage(100, 20), { type: 'text_end', contentIndex: 0, content })
  out({ type: 'message_end', message: assistant([{ type: 'text', text: content }]) })
  void final
}
async function tool(toolName, args, result, isError = false, partial = null) {
  const toolCallId = `call-${++tools}`
  out({ type: 'tool_execution_start', toolCallId, toolName, args })
  if (partial) {
    out({
      type: 'tool_execution_update',
      toolCallId,
      toolName,
      args,
      partialResult: { content: [{ type: 'text', text: partial }] },
    })
    await sleep(5)
  }
  if (toolName === 'exit_plan_mode') {
    // 计划确认：开始执行时像批准扩展一样报新的权限模式，再回工具结果
    const id = `ui-${++tools}`
    out({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title: '计划已就绪，要开始执行吗？ / Ready to implement this plan?' + String.fromCharCode(10) + args.plan,
      options: ['开始执行 / Start implementing', '继续完善计划 / Keep planning'],
    })
    const start = await new Promise(resolve => (approval = { id, resolve }))
    if (start === true)
      out({
        type: 'extension_ui_request',
        id: `ui-${++tools}`,
        method: 'setStatus',
        statusKey: 'pixelsky-mode',
        statusText: 'default',
      })
    result = {
      content: [
        {
          type: 'text',
          text: start === true ? 'The user approved the plan.' : 'The user wants to keep refining the plan.',
        },
      ],
    }
  }
  if (toolName === 'bash' && (args.command === 'rm x' || args.command === 'rm y')) {
    // 批准流程：等界面回答。rm x 是旧版批准扩展的 confirm，rm y 是新版的三选一 select
    const id = `ui-${++tools}`
    out(
      args.command === 'rm x'
        ? {
            type: 'extension_ui_request',
            id,
            method: 'confirm',
            title: '允许工具 bash？ / Allow tool bash?',
            message: 'rm x',
          }
        : {
            type: 'extension_ui_request',
            id,
            method: 'select',
            title: '允许工具 bash？ / Allow tool bash?' + String.fromCharCode(10) + 'rm y',
            options: ['允许 / Allow', '本会话不再询问 / Always allow in this session', '拒绝 / Deny'],
          },
    )
    const confirmed = await new Promise(resolve => (approval = { id, resolve }))
    if (confirmed === 'cancelled') {
      out({
        type: 'tool_execution_end',
        toolCallId,
        toolName,
        result: { content: [{ type: 'text', text: 'cancelled' }] },
        isError: true,
      })
      return
    }
    if (!confirmed) {
      out({
        type: 'tool_execution_end',
        toolCallId,
        toolName,
        result: { content: [{ type: 'text', text: 'The user denied the "bash" tool call.' }] },
        isError: true,
      })
      return
    }
  }
  await sleep(5)
  out({ type: 'tool_execution_end', toolCallId, toolName, result, isError })
}
async function turn(prompt) {
  const cancelled = () => running?.aborted
  out({ type: 'agent_start' })
  out({ type: 'turn_start' })
  out({ type: 'message_start', message: { role: 'user', content: prompt, timestamp: Date.now() } })
  out({ type: 'message_end', message: { role: 'user', content: prompt, timestamp: Date.now() } })
  persist()
  if (prompt.includes('慢')) {
    await text('开始')
    // 等 abort 或 steer
    if (!cancelled())
      await new Promise(resolve => {
        running.release = resolve
        steerWaiter = resolve
      })
    if (cancelled()) {
      out({ type: 'agent_end', messages: [], willRetry: false })
      out({ type: 'agent_settled', aborted: true })
      running = null
      return
    }
    await text('收到引导')
  } else if (prompt.includes('交计划')) {
    await tool('exit_plan_mode', { plan: '# 改登录' + String.fromCharCode(10) + '1. 改 a.ts' }, null)
  } else if (prompt.includes('三选一')) {
    await tool('bash', { command: 'rm y' }, { content: [{ type: 'text', text: 'removed' }] })
  } else if (prompt.includes('两条命令')) {
    // 同一条消息里的两条命令（Pi 的并行执行）：先逐个开始、逐个问批准，全问完了再一起跑完
    const calls = []
    for (const command of ['rm a', 'rm b']) {
      const toolCallId = `call-${++tools}`
      out({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args: { command } })
      const id = `ui-${++tools}`
      out({
        type: 'extension_ui_request',
        id,
        method: 'select',
        title: `允许工具 bash？ / Allow tool bash?\n${command}`,
        options: APPROVAL,
      })
      calls.push({ toolCallId, ok: await new Promise(resolve => (approval = { id, resolve })) })
    }
    for (const { toolCallId, ok } of calls)
      out({
        type: 'tool_execution_end',
        toolCallId,
        toolName: 'bash',
        result: { content: [{ type: 'text', text: ok ? 'removed' : 'denied' }] },
        isError: !ok,
      })
    await text('两条都问完了')
  } else if (prompt.includes('子智能体审批')) {
    // 子智能体（task）里要批准的 write：先报上下文（setStatus），紧接着是转过来的询问
    const toolCallId = `call-${++tools}`
    out({
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'task',
      args: { description: '写文件', prompt: 'write' },
    })
    const args = { path: 'child.txt', content: 'from child' }
    out({
      type: 'extension_ui_request',
      id: `ui-${++tools}`,
      method: 'setStatus',
      statusKey: 'pixelsky-approval-context',
      statusText: JSON.stringify({ toolCallId, agentId: 'child-1', label: '写文件', tool: 'write', args }),
    })
    const id = `ui-${++tools}`
    out({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title: '允许工具 write？ / Allow tool write?\nchild.txt',
      options: APPROVAL,
    })
    const ok = await new Promise(resolve => (approval = { id, resolve }))
    out({
      type: 'tool_execution_end',
      toolCallId,
      toolName: 'task',
      result: { content: [{ type: 'text', text: ok ? 'wrote child.txt' : 'denied' }] },
      isError: false,
    })
    await text('子智能体完成')
  } else if (prompt.includes('审批')) {
    await tool('bash', { command: 'rm x' }, { content: [{ type: 'text', text: 'removed' }] })
    await sleep(80) // 取消的批准之后，真的 Pi 会再进模型一轮；给 abort 留出到达的时间
    if (cancelled()) {
      out({ type: 'agent_settled', aborted: true })
      running = null
      return
    }
    await text('审批完成')
  } else if (prompt.includes('工具')) {
    out({ type: 'message_start', message: assistant([]) })
    update(usage(0, 0), { type: 'thinking_start', contentIndex: 0 })
    update(usage(10, 2), { type: 'thinking_delta', contentIndex: 0, delta: '想一想' })
    update(usage(10, 2), { type: 'thinking_end', contentIndex: 0, content: '想一想' })
    out({ type: 'message_end', message: assistant([{ type: 'thinking', thinking: '想一想' }]) })
    await tool('bash', { command: 'ls' }, { content: [{ type: 'text', text: 'a.txt\nb.txt' }] }, false, 'a.txt')
    await tool(
      'bash',
      { command: 'false' },
      { content: [{ type: 'text', text: 'boom\n\nCommand exited with code 2' }] },
      true,
    )
    await tool(
      'edit',
      { path: 'a.txt', edits: [{ oldText: 'hello', newText: 'hi' }] },
      {
        content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.txt.' }],
        details: {
          diff: '-1 hello\n+1 hi',
          patch: 'Index: a.txt\n--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-hello\n+hi\n\\ No newline at end of file\n',
        },
      },
    )
    await tool(
      'write',
      { path: 'new-file.txt', content: 'x\ny\n' },
      { content: [{ type: 'text', text: 'Successfully wrote 4 bytes' }] },
    )
    await tool(
      'todo_write',
      {
        todos: [
          { content: '第一步', status: 'completed' },
          { content: '第二步', status: 'in_progress', activeForm: '正在做第二步' },
        ],
      },
      { content: [{ type: 'text', text: 'Todos updated' }], details: { todos: [] } },
    )
    await tool('read', { path: 'a.txt' }, { content: [{ type: 'text', text: 'hi' }] })
    await text('工具都跑完了')
  } else if (prompt.includes('错误')) {
    out({ type: 'message_start', message: assistant([]) })
    out({
      type: 'message_end',
      message: assistant([], { stopReason: 'error', errorMessage: '模型接口 529 overloaded' }),
    })
  } else if (prompt.includes('重试失败') || prompt.includes('重试等待')) {
    // 每次都 529：最多重试 3 次（Pi 的默认），用完报 auto_retry_end(false)；等重试时 abort / abort_retry 取消等待
    const max = 3,
      wait = prompt.includes('重试等待') ? 5000 : 20
    for (let attempt = 0; ; ) {
      out({ type: 'message_start', message: assistant([]) })
      out({
        type: 'message_end',
        message: assistant([], { stopReason: 'error', errorMessage: '模型接口 529 overloaded' }),
      })
      if (attempt >= max) {
        out({ type: 'auto_retry_end', success: false, attempt, finalError: '模型接口 529 overloaded' })
        break
      }
      attempt++
      out({ type: 'auto_retry_start', attempt, maxAttempts: max, delayMs: wait, errorMessage: '529 overloaded' })
      const stopped = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), wait)
        retryWaiter = () => {
          clearTimeout(timer)
          resolve(true)
        }
      })
      retryWaiter = null
      if (stopped) {
        out({ type: 'auto_retry_end', success: false, attempt, finalError: 'Retry cancelled' })
        break
      }
    }
    if (cancelled()) {
      out({ type: 'agent_end', messages: [], willRetry: false })
      out({ type: 'agent_settled', aborted: true })
      running = null
      return
    }
  } else if (prompt.includes('重试')) {
    out({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 50, errorMessage: '529 overloaded' })
    await sleep(60)
    out({ type: 'auto_retry_end', success: true, attempt: 2 })
    await text('重试成功')
  } else if (prompt.includes('压缩')) {
    out({ type: 'compaction_start', reason: 'threshold' })
    await sleep(10)
    out({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 's', tokensBefore: 150000, estimatedTokensAfter: 3000, usage: usage(500, 50) },
      aborted: false,
      willRetry: false,
    })
    await text('压缩后继续')
  } else if (prompt.includes('崩溃')) {
    process.stderr.write('fatal: fake pixel crashed\n')
    process.exit(3)
  } else {
    await text('收到：' + prompt)
  }
  out({ type: 'agent_end', messages: [], willRetry: false })
  out({ type: 'agent_settled', aborted: false })
  running = null
}

/**
 * prompt 的回应在 Pi 做完发送前的准备后才发（rpc-mode.js 的 preflightResult）：
 * 「先总结」先压缩一次上下文（FAKE_PIXEL_COMPACT_MS 毫秒，比适配器等回应的时间长）；「卡住」一直准备不完，直到 abort
 */
async function start(m) {
  const run = running
  // 只看用户这条消息本身（交接材料里可能带着以前的消息原文）
  const own = m.message.split('</pixelsky-handoff>').pop()
  if (own.includes('先总结')) {
    out({ type: 'compaction_start', reason: 'threshold' })
    await sleep(Number(process.env.FAKE_PIXEL_COMPACT_MS || 400))
    out({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 's', tokensBefore: 150000, estimatedTokensAfter: 3000, usage: usage(500, 50) },
      aborted: false,
      willRetry: false,
    })
  } else if (own.includes('卡住')) {
    await new Promise(resolve => (run.release = resolve))
    run.release = null
  }
  response(m, { disposition: 'started' })
  if (run.aborted) {
    out({ type: 'agent_end', messages: [], willRetry: false })
    out({ type: 'agent_settled', aborted: true })
    running = null
    return
  }
  void turn(m.message)
}

readline
  .createInterface({ input: process.stdin })
  .on('line', line => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (process.env.FAKE_PIXEL_LOG) appendFileSync(process.env.FAKE_PIXEL_LOG, JSON.stringify(m) + '\n')
    if (m.type === 'extension_ui_response') {
      if (approval?.id === m.id) {
        approval.resolve(
          m.cancelled
            ? 'cancelled'
            : 'value' in m
              ? m.value !== '拒绝 / Deny' && m.value !== '继续完善计划 / Keep planning'
              : m.confirmed === true,
        )
        approval = null
      }
      return
    }
    switch (m.type) {
      case 'get_state':
        return response(m, {
          model,
          thinkingLevel,
          isStreaming: !!running,
          isCompacting: false,
          sessionFile,
          sessionId: 'fake-' + sessionNo,
          autoCompactionEnabled: true,
          messageCount: messages,
          pendingMessageCount: 0,
        })
      case 'get_available_models':
        // FAKE_PIXEL_SLOW_START：连接时这一步慢（毫秒），用来测启动期间的停止
        if (process.env.FAKE_PIXEL_SLOW_START)
          return void setTimeout(() => response(m, { models }), Number(process.env.FAKE_PIXEL_SLOW_START))
        return response(m, { models })
      case 'set_model': {
        const found = models.find(x => x.provider === m.provider && x.id === m.modelId)
        if (!found) return fail(m, `Model not found: ${m.provider}/${m.modelId}`)
        model = found
        // 和 Pi 一样：换模型时按新模型夹紧思考级别
        setLevel(thinkingLevel)
        return response(m, model)
      }
      case 'set_thinking_level':
        setLevel(m.level)
        return response(m)
      case 'get_available_thinking_levels':
        // FAKE_PIXEL_OLD：旧版命令行没有这个命令
        if (process.env.FAKE_PIXEL_OLD) return fail(m, 'Unknown command: ' + m.type)
        return response(m, { levels: supportedLevels(model) })
      case 'set_auto_retry':
        return response(m)
      case 'abort_retry':
        retryWaiter?.()
        return response(m)
      case 'get_commands':
        return response(m, {
          commands: [
            ...(process.env.FAKE_PIXEL_SPEED ? [{ name: 'pixelsky-speed', source: 'extension' }] : []),
            { name: 'pixelsky-mode', source: 'extension', sourceInfo: { path: '/ext/approval.ts' } },
            { name: 'pixelsky-mcp', source: 'extension', sourceInfo: { path: '/ext/mcp.ts' } },
            {
              name: 'review',
              description: 'User extension command',
              source: 'extension',
              sourceInfo: { path: '/home/.pixelsky-cli/agent/extensions/review.ts' },
            },
            {
              name: 'skill:probe',
              description: 'Probe skill',
              source: 'skill',
              sourceInfo: { path: '/skills/probe/SKILL.md' },
            },
          ],
        })
      case 'get_session_stats':
        return response(m, {
          sessionFile,
          sessionId: 'fake-' + sessionNo,
          tokens: { input: existsSync(sessionFile) ? 1000 : 0, output: 100, cacheRead: 0, cacheWrite: 0, total: 1100 },
          cost: existsSync(sessionFile) ? 0.5 : 0,
          contextUsage: { tokens: 1100, contextWindow: 200000, percent: 0.5 },
        })
      case 'switch_session':
        // FAKE_PIXEL_SWITCH_FAIL：文件在、却接不上（例如文件坏了）
        if (process.env.FAKE_PIXEL_SWITCH_FAIL) return fail(m, 'Session file is corrupt: ' + m.sessionPath)
        if (!existsSync(m.sessionPath)) return fail(m, 'Session file not found: ' + m.sessionPath)
        sessionFile = m.sessionPath
        return response(m, { cancelled: false })
      case 'prompt': {
        if (m.message.startsWith('/pixelsky-speed ') && process.env.FAKE_PIXEL_SPEED) {
          const [, speed, req] = m.message.split(' ')
          out({
            type: 'extension_ui_request',
            method: 'setStatus',
            statusKey: 'pixelsky-speed',
            statusText: JSON.stringify({
              version: 1,
              req,
              speed,
              error: process.env.FAKE_PIXEL_SPEED_FAIL === speed ? 'Rejected speed' : '',
            }),
          })
          return response(m, { disposition: 'handled' })
        }
        if (m.message.startsWith('/pixelsky-mode ')) return response(m, { disposition: 'handled' })
        if (running) return fail(m, 'Agent is already processing')
        messages++
        running = { aborted: false, release: null }
        void start(m)
        return
      }
      case 'steer':
        if (!running) return fail(m, 'not streaming')
        response(m, { disposition: 'queued' })
        out({ type: 'queue_update', steering: [m.message], followUp: [] })
        setTimeout(() => {
          out({ type: 'queue_update', steering: [], followUp: [] })
          out({ type: 'message_start', message: { role: 'user', content: m.message, timestamp: Date.now() } })
          out({ type: 'message_end', message: { role: 'user', content: m.message, timestamp: Date.now() } })
          steerWaiter?.()
        }, 20)
        return
      case 'abort':
        if (running) {
          running.aborted = true
          running.release?.()
          retryWaiter?.()
          // 等批准的对话框被取消后才结束
          approval?.resolve('cancelled')
        }
        return response(m)
      case 'compact':
        out({ type: 'compaction_start', reason: 'manual' })
        out({
          type: 'compaction_end',
          reason: 'manual',
          result: { summary: 's', tokensBefore: 9000, estimatedTokensAfter: 1000 },
          aborted: false,
          willRetry: false,
        })
        return response(m, { summary: 's', tokensBefore: 9000, estimatedTokensAfter: 1000 })
      default:
        return fail(m, 'Unknown command: ' + m.type)
    }
  })
  .on('close', () => process.exit(0))
