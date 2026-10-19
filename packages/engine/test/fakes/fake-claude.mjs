// 假的 Claude Code：说 stream-json + control 协议，用来测 EngineHost / ClaudeSession，不调用真实模型。
//
// 根据用户消息内容决定行为：
//   含「思考」→ 先发 thinking 块，停 1.5 秒再回正文
//   含「表格」→ 回很宽的 Markdown 表格（8 列 5 行）
//   含「计划」→ 发 TodoWrite（5 项）再回正文
//   含「写文件」→ 调用 Write 工具，先发 can_use_tool 等审批，允许就「写入」，拒绝就报错
//   含「慢」    → 慢慢输出 100 段文字（给中断测试用）
//   含「崩溃」  → 往 stderr 写 boom 然后退出码 3
//   含「子任务」→ 派一个子智能体（task_* 帧 + 子智能体调用 Read）
//   含「派出」  → 派一个后台子智能体，这一轮先结束，子智能体跑完后引擎自己接着汇总一轮
//   含「后台」  → 起一个后台命令（background_tasks_changed），等 stop_task 才结束
//   含「并行」  → 起后台子智能体 bga1「甲」、bga2「乙」，多智能体编排 wf1「编排」和后台命令 bg1，然后慢慢输出直到被中断
//   一轮成功结束后发一条 prompt_suggestion
//   FAKE_CLAUDE_REPLAY=1  收到用户消息后先回显一帧 isReplay 的用户消息（真实 CLI 的 --replay-user-messages）
//   含「断线」  → 第一次没有任何输出就以网络类报错结束这一轮（FAKE_CLAUDE_DROP_FLAG 指向的文件记录已断过）
//   FAKE_CLAUDE_FAST_BLOCKED  Fast 模式开不了的原因（不设时可以开）
//   其他       → 回复「收到：<消息>」
// 环境变量：
//   FAKE_CLAUDE_LOG       每次启动把命令行参数追加到这个文件（一行一个 JSON 数组）
//                         另外把收到的控制请求类型按顺序写到 .control.log（一行一个）
//   FAKE_CLAUDE_MODEL_LOG 收到 set_model 时把模型名追加到这个文件（一行一个）
//   FAKE_CLAUDE_PROJECTS  收到消息时在这里创建会话记录文件（模拟 ~/.claude/projects）
//   FAKE_CLAUDE_REWIND    rewind_files 的模拟：JSON { file, content }，预览时报这个文件，还原时写入 content；
//                         user_message_id 以 nocp 开头时报没有检查点
// -p --output-format json（旁聊）：从 stdin 读问题，回一个 result（含问题、--tools、能看到的用户消息）
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const argv = process.argv.slice(2)
if (process.env.FAKE_CLAUDE_ENV_LOG)
  writeFileSync(
    process.env.FAKE_CLAUDE_ENV_LOG,
    JSON.stringify({
      base: process.env.ANTHROPIC_BASE_URL,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
      key: process.env.ANTHROPIC_API_KEY,
      autoCompact: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
    }),
  )
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + '\n')
// 像真的 Claude Code 一样拒绝不认识的参数（测试用 --fake-bad-arg）；测试创建开关文件时一启动就报错退出
if (argv.includes('--fake-bad-arg')) {
  process.stderr.write("error: unknown option '--fake-bad-arg'\n(Did you mean --fake-good-arg?)\n")
  process.exit(1)
}
if (process.env.FAKE_CLAUDE_START_FAIL_FILE && existsSync(process.env.FAKE_CLAUDE_START_FAIL_FILE)) {
  process.stderr.write('Error: fake startup failure\n')
  process.exit(1)
}

const arg = name => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
const sessionId = arg('--session-id') ?? arg('--resume') ?? 'fake-session'
// 分叉：从 --resume 的记录读，按 --session-id 写
const forkFrom = argv.includes('--fork-session') ? arg('--resume') : null
let permissionMode = arg('--permission-mode') ?? 'default'
let ultracode = false
let fastMode = false
let thinkingDisplay = null
const fastBlocked = process.env.FAKE_CLAUDE_FAST_BLOCKED ?? ''
/** 「始终允许」过的工具 */
const allowedTools = new Set()
const bgTasks = new Map()
// FAKE_CLAUDE_NO_ULTRACODE=1 模拟当前模型不支持 Ultracode
const ultracodeAvailable = process.env.FAKE_CLAUDE_NO_ULTRACODE !== '1'
const cwd = process.cwd()

const out = o => process.stdout.write(JSON.stringify(o) + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))

let turn = null // { aborted: boolean }
const pendingInputs = []
let foldedUuids = []
let inputUuid = null
const pendingAnswers = new Map()
let msgSeq = 0
// 真实 API 的消息 id 全局唯一；带上进程前缀，换进程（回退、恢复）后不与旧回复重复
const runId = process.pid.toString(36)
let cost = 0

function transcriptFile(id = sessionId) {
  const dir = process.env.FAKE_CLAUDE_PROJECTS
  if (!dir) return null
  const sub = join(dir, cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(sub, { recursive: true })
  return join(sub, `${id}.jsonl`)
}

function touchTranscript() {
  const file = transcriptFile()
  if (file && !process.env.FAKE_CLAUDE_CHAIN) writeFileSync(file, '{}\n')
}

// FAKE_CLAUDE_CHAIN=1：像真实 CLI 一样写 user / assistant 链（uuid、parentUuid），
// 支持 --resume-session-at=<uuid> 截断；FAKE_CLAUDE_CHAIN_LOG 记录启动时模型能看到的用户消息。
const resumeAt = argv.find(a => a.startsWith('--resume-session-at='))?.slice('--resume-session-at='.length) ?? null
let chainTail = null
if (process.env.FAKE_CLAUDE_CHAIN) {
  const file = transcriptFile(forkFrom ?? sessionId)
  const entries =
    file && existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l))
      : []
  const byId = new Map(entries.map(e => [e.uuid, e]))
  // 像真实 CLI：只加载最近一次压缩之后的部分，更早的截断点也找不到
  const boundary = entries.findLastIndex(e => e.type === 'system' && e.subtype === 'compact_boundary')
  if (resumeAt && entries.findIndex(e => e.uuid === resumeAt) <= boundary) {
    process.stderr.write(`No message found with uuid ${resumeAt}\n`)
    process.exit(1)
  }
  // 像真实 CLI 选从哪条接着读：最后一条 last-prompt 的 leafUuid 还是分支末端（没有子条目）就用它，
  // 否则用最后写进去的消息（GitHub #82）
  const messages = entries.filter(e => e.uuid)
  const leaf = entries.findLast(e => e.type === 'last-prompt')?.leafUuid
  const isLeaf = leaf && byId.has(leaf) && !messages.some(e => e.parentUuid === leaf)
  chainTail = resumeAt ?? (isLeaf ? leaf : (messages.at(-1)?.uuid ?? null))
  const visible = []
  for (let id = chainTail; id; id = byId.get(id)?.parentUuid)
    if (byId.get(id)?.type === 'user') visible.unshift(byId.get(id).text)
  if (process.env.FAKE_CLAUDE_CHAIN_LOG && !argv.includes('--no-session-persistence'))
    appendFileSync(process.env.FAKE_CLAUDE_CHAIN_LOG, JSON.stringify(visible) + '\n')
  // 分叉且要保存：把截断点之前的链复制到新会话的记录里
  if (forkFrom && !argv.includes('--no-session-persistence')) {
    const copied = []
    for (let id = chainTail; id; id = byId.get(id)?.parentUuid) copied.unshift(byId.get(id))
    writeFileSync(transcriptFile(), copied.map(e => JSON.stringify(e) + '\n').join(''))
  }
  if (arg('--output-format') === 'json') {
    // 旁聊：单次问答
    let q = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => (q += d))
    process.stdin.on('end', () => {
      const question = q.trim().split('\n').at(-1)
      process.stdout.write(
        JSON.stringify({
          type: 'result',
          is_error: false,
          result: `${question}｜工具=[${arg('--tools')}]｜看到=${visible.join(',')}`,
        }) + '\n',
      )
      process.exit(0)
    })
  }
}
function chain(type, uuid, text) {
  const file = transcriptFile()
  if (!file || !process.env.FAKE_CLAUDE_CHAIN) return
  appendFileSync(file, JSON.stringify({ type, uuid, parentUuid: chainTail, text }) + '\n')
  chainTail = uuid
}

function stream(event) {
  out({ type: 'stream_event', event, parent_tool_use_id: null, session_id: sessionId })
}

async function streamText(text, pieces) {
  const id = `msg_fake_${runId}_${++msgSeq}`
  const cacheProbe = process.env.FAKE_CLAUDE_CACHE_ALERT === '1'
  if (cacheProbe)
    stream({
      type: 'message_start',
      message: {
        id: `${id}_baseline`,
        model: 'fake-model',
        usage: { input_tokens: 10000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })
  stream({
    type: 'message_start',
    message: {
      id,
      model: 'fake-model',
      usage: cacheProbe
        ? { input_tokens: 12000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        : { input_tokens: 10 },
    },
  })
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  let sent = ''
  for (const p of pieces) {
    if (turn?.aborted) {
      out({
        type: 'assistant',
        message: { id, content: [{ type: 'text', text: sent }] },
        parent_tool_use_id: null,
        aborted: true,
      })
      return false
    }
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })
    sent += p
    if (pieces.length > 5) await sleep(30)
  }
  out({ type: 'assistant', message: { id, content: [{ type: 'text', text }] }, parent_tool_use_id: null })
  stream({ type: 'content_block_stop', index: 0 })
  stream({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 5 },
  })
  stream({ type: 'message_stop' })
  return true
}

// 进程内累计的 token（真实 Claude 的 modelUsage 也是进程内累计值，进程重启后从零开始）
const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

function result(subtype, extra = {}) {
  cost += 0.01
  totals.inputTokens += 10
  totals.outputTokens += 5
  totals.cacheReadInputTokens += 90
  out({
    type: 'result',
    ...(process.env.FAKE_CLAUDE_GUIDE
      ? { user_message_uuid: inputUuid, user_message_uuids: [inputUuid, ...foldedUuids] }
      : {}),
    subtype,
    is_error: subtype !== 'success',
    session_id: sessionId,
    total_cost_usd: cost,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: { 'fake-model': { ...totals, costUSD: cost, contextWindow: 200000 } },
    terminal_reason: subtype === 'success' ? 'completed' : 'aborted_streaming',
    ...extra,
  })
}

function ask(toolUseId, input) {
  const requestId = `perm-${toolUseId}`
  out({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      input,
      tool_use_id: toolUseId,
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    },
  })
  return new Promise(resolve => pendingAnswers.set(requestId, resolve))
}

async function runTurn(text) {
  turn = { aborted: false }
  touchTranscript()
  out({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd,
    model: 'fake-model',
    permissionMode,
    ...(process.env.FAKE_CLAUDE_GUIDE
      ? { capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1', 'interrupt_cancel_queued_v1'] }
      : {}),
  })

  if (text === '/compact' && process.env.FAKE_CLAUDE_CONTEXT === '1') {
    out({ type: 'system', subtype: 'status', status: 'compacting' })
    await sleep(30)
    out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 60000 } })
    result('success', { local_command: 'compact', result: 'Compacted' })
    turn = null
    return
  }

  if (text.includes('认证失败')) {
    // 和真的 Claude Code 一样：先发一条合成的报错消息（model 是 <synthetic>，带 error 代码），再发失败结果
    const reason = 'Invalid API key · Fix external API key'
    out({
      type: 'assistant',
      message: {
        id: `msg_fake_${runId}_${++msgSeq}`,
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: reason }],
      },
      parent_tool_use_id: null,
      error: 'authentication_failed',
    })
    result('success', { is_error: true, result: reason })
    turn = null
    return
  }

  if (text.includes('断线') && !(process.env.FAKE_CLAUDE_DROP_FLAG && existsSync(process.env.FAKE_CLAUDE_DROP_FLAG))) {
    // 第一次遇到「断线」：没有任何助手输出，直接以网络类报错结束这一轮（之后重发 / 继续时正常回复；FAKE_CLAUDE_DROP_FLAG 记录已断过）
    if (process.env.FAKE_CLAUDE_DROP_FLAG) writeFileSync(process.env.FAKE_CLAUDE_DROP_FLAG, '1')
    result('success', { is_error: true, result: 'API Error: Unable to connect to API (ECONNRESET)' })
    turn = null
    return
  }

  if (text.includes('崩溃')) {
    process.stderr.write('boom\n')
    process.exit(3)
  }

  if (text.includes('思考')) {
    // 先一个 thinking 块（真实格式：thinking 文本 + signature），停一会儿再出正文
    out({
      type: 'assistant',
      message: {
        id: `msg_fake_${runId}_${++msgSeq}`,
        model: 'fake-model',
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: '用户想让我想一想。先把问题拆开：确认前提，再逐条比较，最后给出结论。',
            signature: 'ErUBCkYIARgCIkB0ZmFrZXNpZ25hdHVyZQ==',
          },
        ],
      },
      parent_tool_use_id: null,
    })
    await sleep(1500)
    await streamText('想好了：先确认前提，再逐条比较，结论是可以做。', [
      '想好了：',
      '先确认前提，再逐条比较，结论是可以做。',
    ])
    result('success')
    turn = null
    return
  }

  if (text.includes('表格')) {
    // 很宽的表格（8 列 5 行，单元格很长），手机屏幕放不下，测横向滚动
    const cols = [
      '模块名称',
      '负责人员',
      '当前状态',
      '预计完成时间',
      '涉及的主要文件',
      '依赖的其他模块',
      '风险与注意事项',
      '验收标准说明',
    ]
    const rows = Array.from({ length: 5 }, (_, r) => cols.map(c => `${c}第${r + 1}行的内容比较长用来撑宽`))
    const table = [
      `| ${cols.join(' | ')} |`,
      `| ${cols.map(() => '---').join(' | ')} |`,
      ...rows.map(row => `| ${row.join(' | ')} |`),
    ].join('\n')
    const full = `下面是汇总表：\n\n${table}\n\n以上就是全部内容。`
    await streamText(full, [full])
    result('success')
    turn = null
    return
  }

  if (text.includes('计划')) {
    // TodoWrite：5 项（2 完成、1 进行中、2 待办）
    const toolUseId = `toolu_fake_${++msgSeq}`
    const todos = [
      { content: '读现有代码', status: 'completed', activeForm: '正在读现有代码' },
      { content: '设计方案', status: 'completed', activeForm: '正在设计方案' },
      { content: '实现功能', status: 'in_progress', activeForm: '正在实现功能' },
      { content: '补测试', status: 'pending', activeForm: '正在补测试' },
      { content: '更新文档', status: 'pending', activeForm: '正在更新文档' },
    ]
    out({
      type: 'assistant',
      message: {
        id: `msg_fake_${runId}_${msgSeq}`,
        content: [{ type: 'tool_use', id: toolUseId, name: 'TodoWrite', input: { todos } }],
      },
      parent_tool_use_id: null,
    })
    out({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content:
              'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.',
          },
        ],
      },
      parent_tool_use_id: null,
      tool_use_result: { oldTodos: [], newTodos: todos },
    })
    await streamText('计划列好了，先做第三项。', ['计划列好了，先做第三项。'])
    result('success')
    turn = null
    return
  }

  if (text.includes('写文件')) {
    const toolUseId = `toolu_fake_${++msgSeq}`
    const input = { file_path: join(cwd, 'hello.txt'), content: 'hi' }
    out({
      type: 'assistant',
      message: {
        id: `msg_fake_${runId}_${msgSeq}`,
        content: [{ type: 'tool_use', id: toolUseId, name: 'Write', input }],
      },
      parent_tool_use_id: null,
    })
    const answer = allowedTools.has('Write') ? { behavior: 'allow' } : await ask(toolUseId, input)
    if (answer.behavior === 'allow') {
      for (const p of Array.isArray(answer.updatedPermissions) ? answer.updatedPermissions : []) {
        if (p.type === 'addRules' && p.behavior === 'allow') {
          for (const rule of p.rules) allowedTools.add(rule.toolName)
          if (process.env.FAKE_CLAUDE_LOG)
            appendFileSync(process.env.FAKE_CLAUDE_LOG.replace(/\.log$/, '.perm.log'), JSON.stringify(p) + '\n')
        }
      }
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'File created successfully' }],
        },
        parent_tool_use_id: null,
        tool_use_result: { type: 'create', filePath: input.file_path, content: 'hi', structuredPatch: [] },
      })
    } else {
      out({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: answer.message, is_error: true }],
        },
        parent_tool_use_id: null,
        tool_use_result: `Error: ${answer.message}`,
      })
    }
    await streamText('完成', ['完成'])
    result('success')
    turn = null
    return
  }

  if (text.includes('子任务')) {
    const toolUseId = `toolu_agent_${++msgSeq}`
    out({
      type: 'assistant',
      message: {
        id: `msg_fake_${runId}_${msgSeq}`,
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Agent',
            input: { description: '读 README', subagent_type: 'general-purpose', prompt: '读一下 README' },
          },
        ],
      },
      parent_tool_use_id: null,
    })
    out({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent1',
      tool_use_id: toolUseId,
      description: '读 README',
      subagent_type: 'general-purpose',
      task_type: 'local_agent',
    })
    out({
      type: 'assistant',
      message: {
        id: 'msg_sub_1',
        content: [
          { type: 'tool_use', id: 'toolu_sub_read', name: 'Read', input: { file_path: join(cwd, 'README.md') } },
        ],
      },
      parent_tool_use_id: toolUseId,
    })
    out({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'agent1',
      description: '读 README',
      last_tool_name: 'Read',
      usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 800 },
    })
    out({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub_read', content: '# demo' }] },
      parent_tool_use_id: toolUseId,
    })
    out({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent1',
      status: 'completed',
      summary: '读完了',
      output_file: '',
      usage: { total_tokens: 1500, tool_uses: 1, duration_ms: 1000 },
    })
    out({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'README 里写着 demo' }],
      },
      parent_tool_use_id: null,
      tool_use_result: {
        agentId: 'agent1',
        status: 'completed',
        resolvedModel: 'claude-sonnet-5-5',
        totalTokens: 1500,
        totalToolUseCount: 1,
        totalDurationMs: 1000,
      },
    })
    await streamText('子任务完成', ['子任务完成'])
    result('success')
    out({ type: 'prompt_suggestion', suggestion: '再读一遍', session_id: sessionId })
    turn = null
    return
  }

  if (text.includes('派出')) {
    // 派一个后台子智能体：Agent 工具马上回「已在后台启动」，这一轮说完就结束；FAKE_CLAUDE_AGENT_MS 后子智能体跑完，
    // 引擎没等用户发消息就接着干（汇总），再结束一轮
    const toolUseId = `toolu_fake_${++msgSeq}`
    out({
      type: 'assistant',
      message: {
        id: `msg_fake_${runId}_${msgSeq}`,
        content: [
          { type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: '对比', run_in_background: true } },
        ],
      },
      parent_tool_use_id: null,
    })
    out({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Async agent launched' }],
      },
      parent_tool_use_id: null,
      tool_use_result: { isAsync: true, status: 'async_launched', agentId: 'bga1', description: '对比' },
    })
    out({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bga1',
      task_type: 'local_agent',
      description: '对比',
      tool_use_id: toolUseId,
      is_backgrounded: true,
    })
    bgTasks.set('bga1', { task_id: 'bga1', task_type: 'local_agent', description: '对比' })
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [...bgTasks.values()] })
    await streamText('都派出去了', ['都派出去了'])
    result('success')
    turn = null
    await sleep(Number(process.env.FAKE_CLAUDE_AGENT_MS ?? 300))
    bgTasks.delete('bga1')
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [...bgTasks.values()] })
    out({ type: 'system', subtype: 'task_notification', task_id: 'bga1', status: 'completed', summary: '对比完了' })
    if (process.env.FAKE_CLAUDE_AGENT_NO_WAKE === '1') return
    turn = { aborted: false }
    await streamText('汇总完成', ['汇总完成'])
    result('success')
    turn = null
    return
  }

  if (text.includes('并行')) {
    for (const [tid, desc] of [
      ['bga1', '甲'],
      ['bga2', '乙'],
    ]) {
      out({
        type: 'system',
        subtype: 'task_started',
        task_id: tid,
        task_type: 'local_agent',
        description: desc,
        tool_use_id: `tu_${tid}`,
        is_backgrounded: true,
      })
      bgTasks.set(tid, { task_id: tid, task_type: 'local_agent', description: desc })
    }
    out({
      type: 'system',
      subtype: 'task_started',
      task_id: 'wf1',
      task_type: 'local_workflow',
      description: '编排',
      is_backgrounded: true,
    })
    bgTasks.set('wf1', { task_id: 'wf1', task_type: 'local_workflow', description: '编排' })
    out({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bg1',
      task_type: 'local_bash',
      description: 'npm run dev',
      is_backgrounded: true,
    })
    bgTasks.set('bg1', { task_id: 'bg1', task_type: 'local_bash', description: 'npm run dev' })
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [...bgTasks.values()] })
    const slow = Array.from({ length: 100 }, (_, i) => `${i} `)
    const ok = await streamText(slow.join(''), slow)
    if (!ok) {
      out({
        type: 'user',
        message: { role: 'user', content: '[Request interrupted by user]' },
        parent_tool_use_id: null,
      })
      result('error_during_execution')
    } else result('success')
    turn = null
    return
  }

  if (text.includes('后台')) {
    bgTasks.set('bg1', { task_id: 'bg1', task_type: 'local_bash', description: 'npm run dev' })
    out({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bg1',
      description: 'npm run dev',
      task_type: 'local_bash',
      is_backgrounded: true,
    })
    out({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [...bgTasks.values(), { task_id: 'amb', task_type: 'local_bash', description: '内部', ambient: true }],
    })
    out({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'bg1',
      description: '服务已启动',
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 10 },
    })
    await streamText('后台已启动', ['后台已启动'])
    result('success')
    turn = null
    return
  }

  if (text.includes('后续')) {
    // 这一轮结束后，后台任务完成的通知让引擎没等用户发消息就接着干：先一条通知，再一次模型请求和一个结果
    await streamText('先回答', ['先回答'])
    result('success')
    turn = null
    await sleep(40)
    out({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bg-late',
      status: 'completed',
      summary: '后台命令跑完了',
    })
    turn = { aborted: false }
    const id = `toolu_fake_${++msgSeq}`
    stream({
      type: 'message_start',
      message: { id: `msg_fake_${runId}_${++msgSeq}`, model: 'fake-model', usage: { input_tokens: 10 } },
    })
    out({
      type: 'assistant',
      message: {
        id: `msg_fake_${runId}_${msgSeq}`,
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo cleanup' } }],
      },
      parent_tool_use_id: null,
    })
    out({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'cleanup' }] },
      parent_tool_use_id: null,
    })
    await sleep(Number(process.env.FAKE_CLAUDE_CONTINUE_MS ?? 0))
    await streamText('清理完了', ['清理完了'])
    result('success')
    turn = null
    return
  }

  const pieces = text.includes('慢') ? Array.from({ length: 100 }, (_, i) => `${i} `) : ['收到：', text]
  const full = pieces.join('')
  const ok = await streamText(full, pieces)
  if (!ok) {
    out({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' }, parent_tool_use_id: null })
    result('error_during_execution')
  } else {
    result('success')
    out({ type: 'prompt_suggestion', suggestion: '接着说', session_id: sessionId })
  }
  turn = null
}

let buf = ''
process.stdin.setEncoding('utf8')
// 旁聊（-p --output-format json）的 stdin 是问题原文，上面已经单独读了
if (arg('--output-format') !== 'json')
  process.stdin.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim()) handle(JSON.parse(line))
    }
  })
// FAKE_CLAUDE_LINGER=1：像忙着的真实 CLI 一样，stdin 关了也不退（只能被强制结束）；
// FAKE_CLAUDE_HELPER_LINGER=1 只对恢复代码的辅助进程（带 --bare）这样，像真实 CLI 退出要再等一会儿
if (
  process.env.FAKE_CLAUDE_LINGER === '1' ||
  (process.env.FAKE_CLAUDE_HELPER_LINGER === '1' && argv.includes('--bare'))
)
  setInterval(() => {}, 1000)
else if (arg('--output-format') !== 'json')
  process.stdin.on('end', () => {
    // 像真实 CLI：会话进程退出时记下这次读到的末端（下次 --resume 从这里接着读，GitHub #82）
    const file = transcriptFile()
    if (process.env.FAKE_CLAUDE_CHAIN && file && chainTail && !argv.includes('--bare'))
      appendFileSync(
        file,
        JSON.stringify({ type: 'last-prompt', lastPrompt: '', leafUuid: chainTail, sessionId }) + '\n',
      )
    process.exit(0)
  })

function respond(requestId, response) {
  out({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
}

function handle(msg) {
  if (msg.type === 'control_request') {
    const r = msg.request
    if (process.env.FAKE_CLAUDE_LOG)
      appendFileSync(process.env.FAKE_CLAUDE_LOG.replace(/\.log$/, '.control.log'), `${r.subtype}\n`)
    switch (r.subtype) {
      case 'initialize':
        const initialized = {
          models: [
            {
              value: 'default',
              displayName: 'Default (recommended)',
              description: 'Opus 5.5 · Most capable for complex work',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
            {
              value: 'opus',
              resolvedModel: 'claude-opus-5-5',
              displayName: 'Opus 5.5',
              description: 'For complex work and everyday tasks',
              supportsEffort: true,
              supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
              supportsFastMode: true,
            },
            {
              value: 'haiku',
              resolvedModel: 'claude-haiku-5-5',
              displayName: 'Haiku 5.5',
              description: 'Fastest model for simple tasks',
              supportsEffort: false,
            },
          ],
          commands: process.env.FAKE_CLAUDE_COMMANDS
            ? JSON.parse(process.env.FAKE_CLAUDE_COMMANDS)
            : process.env.FAKE_CLAUDE_CONTEXT === '1'
              ? [{ name: 'context' }, { name: 'compact' }]
              : [],
          current_permission_mode: permissionMode,
          output_style: 'default',
          available_output_styles: ['default', 'Explanatory', 'Learning'],
          fast_mode_state: fastMode ? 'on' : 'off',
          fast_mode_disabled_reason: fastBlocked || (fastMode ? undefined : 'sdk_opt_in_required'),
        }
        if (process.env.FAKE_CLAUDE_INIT_DELAY)
          setTimeout(() => respond(msg.request_id, initialized), Number(process.env.FAKE_CLAUDE_INIT_DELAY))
        else respond(msg.request_id, initialized)
        return
      case 'set_max_thinking_tokens':
        thinkingDisplay = r.thinking_display
        if (process.env.FAKE_CLAUDE_LOG)
          appendFileSync(process.env.FAKE_CLAUDE_LOG.replace(/\.log$/, '.thinking.log'), String(thinkingDisplay) + '\n')
        respond(msg.request_id, {})
        return
      case 'stop_task': {
        const t = bgTasks.get(r.task_id)
        if (t) {
          bgTasks.delete(r.task_id)
          out({ type: 'system', subtype: 'background_tasks_changed', tasks: [...bgTasks.values()] })
          out({
            type: 'system',
            subtype: 'task_notification',
            task_id: r.task_id,
            status: 'stopped',
            summary: t.description,
            output_file: '',
          })
        }
        respond(msg.request_id, {})
        return
      }
      case 'get_context_usage':
        // FAKE_CLAUDE_USAGE=1 才认识这个控制请求（新版 CLI 的形状：驼峰字段、skills 是对象）；否则和旧版一样回空
        if (process.env.FAKE_CLAUDE_USAGE !== '1') {
          respond(msg.request_id, {})
          return
        }
        if (process.env.FAKE_CLAUDE_LOG)
          appendFileSync(
            process.env.FAKE_CLAUDE_LOG.replace(/\.log$/, '.usage.log'),
            `${r.detail}:${turn ? 'running' : 'idle'}\n`,
          )
        respond(msg.request_id, {
          model: 'fake-model',
          totalTokens: r.detail === 'full' ? 42000 : 41000,
          maxTokens: 1000000,
          rawMaxTokens: 1000000,
          categories: [
            { name: 'System prompt', tokens: 2000, kind: 'used' },
            { name: 'System tools (deferred)', tokens: 9000, kind: 'deferred', isDeferred: true },
            { name: 'Skills', tokens: 1000, kind: 'used' },
            { name: 'Messages', tokens: 38000, kind: 'used' },
            { name: 'Free space', tokens: 959000, kind: 'free' },
          ],
          memoryFiles: [{ path: 'CLAUDE.md', type: 'Project', tokens: 24 }],
          mcpTools: [{ name: 'mcp__browser__open', serverName: 'browser', tokens: 400 }],
          agents: [],
          skills: {
            totalSkills: 1,
            includedSkills: 1,
            tokens: 1000,
            skillFrontmatter: [{ name: 'review', source: 'plugin', tokens: 1000 }],
          },
          gridRows: [],
        })
        return
      case 'get_task_output':
        respond(msg.request_id, { output: 'listening on 3000\n', total_bytes: 18, truncated: false })
        return
      case 'interrupt':
        if (turn) turn.aborted = true
        const cancelled = r.cancel_queued ? pendingInputs.splice(0).map(m => m.uuid) : []
        for (const id of cancelled) out({ type: 'command_lifecycle', command_uuid: id, state: 'cancelled' })
        respond(msg.request_id, { still_queued: pendingInputs.map(m => m.uuid), cancelled })
        return
      case 'apply_flag_settings':
        if (typeof r.settings?.ultracode === 'boolean' && ultracodeAvailable) ultracode = r.settings.ultracode
        if (typeof r.settings?.fastMode === 'boolean' && !fastBlocked) fastMode = r.settings.fastMode
        respond(msg.request_id, {})
        return
      case 'get_settings':
        respond(msg.request_id, {
          applied: {
            model: 'fake-model',
            effort: 'high',
            ultracode,
            ultracodeRequested: ultracode,
            ultracodeAvailable,
          },
        })
        return
      case 'set_permission_mode':
        permissionMode = r.mode
        respond(msg.request_id, { mode: r.mode })
        out({ type: 'system', subtype: 'status', status: null, permissionMode })
        return
      case 'rewind_files': {
        const sim = process.env.FAKE_CLAUDE_REWIND ? JSON.parse(process.env.FAKE_CLAUDE_REWIND) : null
        if (!sim || String(r.user_message_id).startsWith('nocp')) {
          respond(msg.request_id, { canRewind: false, error: 'No file checkpoint found for this message.' })
          return
        }
        if (!r.dry_run) writeFileSync(sim.file, sim.content)
        respond(
          msg.request_id,
          r.dry_run ? { canRewind: true, filesChanged: [sim.file], insertions: 1, deletions: 2 } : { canRewind: true },
        )
        return
      }
      case 'set_model':
        if (process.env.FAKE_CLAUDE_MODEL_LOG) appendFileSync(process.env.FAKE_CLAUDE_MODEL_LOG, r.model + '\n')
        respond(msg.request_id, {})
        return
      default:
        respond(msg.request_id, {})
        return
    }
  }
  if (msg.type === 'control_response') {
    const res = msg.response
    pendingAnswers.get(res.request_id)?.(res.response)
    pendingAnswers.delete(res.request_id)
    return
  }
  if (msg.type === 'user') {
    if (process.env.FAKE_CLAUDE_IMAGES) {
      const content = msg.message.content
      appendFileSync(
        process.env.FAKE_CLAUDE_IMAGES,
        JSON.stringify({
          types: typeof content === 'string' ? ['string'] : content.map(block => block.type),
          text:
            typeof content === 'string'
              ? content
              : content
                  .filter(block => block.type === 'text')
                  .map(block => block.text)
                  .join(''),
          images:
            typeof content === 'string'
              ? []
              : content
                  .filter(block => block.type === 'image')
                  .map(block => ({
                    mediaType: block.source.media_type,
                    bytes: Buffer.from(block.source.data, 'base64').length,
                    sha256: createHash('sha256').update(Buffer.from(block.source.data, 'base64')).digest('hex'),
                  })),
        }) + '\n',
      )
    }
    if (msg.message.content === '/context' && process.env.FAKE_CLAUDE_CONTEXT === '1') {
      if (process.env.FAKE_CLAUDE_CONTEXT_EXIT === '1') {
        process.exit(3)
        return
      }
      const context_usage = {
        model: 'fake-model',
        total_tokens: 60000,
        raw_max_tokens: 200000,
        categories: [
          { name: 'System prompt', tokens: 10000, kind: 'used' },
          { name: 'Messages', tokens: 50000, kind: 'used' },
          { name: 'Autocompact buffer', tokens: 30000, kind: 'buffer' },
          { name: 'Free space', tokens: 110000, kind: 'free' },
        ],
        skills: [],
        memory_files: [],
        mcp_tools: [],
        agents: [],
      }
      const send = () => {
        out({
          type: 'assistant',
          local_command_run: { command: 'context' },
          context_usage,
          message: { model: '<synthetic>', content: [{ type: 'text', text: '诊断不应加入对话' }] },
        })
        out({
          type: 'result',
          local_command: 'context',
          user_message_uuid: msg.uuid,
          is_error: false,
          result: '',
          usage: {},
          modelUsage: {},
        })
      }
      setTimeout(send, Number(process.env.FAKE_CLAUDE_CONTEXT_DELAY ?? 0))
      return
    }
    // --replay-user-messages：收到的用户消息原样回显一帧（isReplay），宿主据此确认「引擎收到了」
    if (process.env.FAKE_CLAUDE_REPLAY === '1')
      out({
        type: 'user',
        message: msg.message,
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: msg.uuid,
        timestamp: new Date().toISOString(),
        isReplay: true,
      })
    if (process.env.FAKE_CLAUDE_GUIDE) {
      out({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'queued' })
      if (turn && process.env.FAKE_CLAUDE_GUIDE === 'fold') {
        foldedUuids.push(msg.uuid)
        out({
          type: 'assistant',
          message: { content: [] },
          user_message_uuid: inputUuid,
          user_message_uuids: [inputUuid, ...foldedUuids],
        })
      } else if (turn) pendingInputs.push(msg)
      else runInput(msg)
      return
    }
    const text = typeof msg.message.content === 'string' ? msg.message.content : ''
    chain('user', msg.uuid, text)
    void runTurn(text).then(() => chain('assistant', randomUUID(), `re:${text}`))
  }
}

function runInput(msg) {
  inputUuid = msg.uuid
  foldedUuids = []
  out({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'started' })
  void runTurn(typeof msg.message.content === 'string' ? msg.message.content : '').finally(() => {
    if (pendingInputs.length) runInput(pendingInputs.shift())
  })
}
