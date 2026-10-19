// 智能体追踪的数据（docs/engines.md §15.4，参考 JuCode claude/runs.rs）：
// 运行中从 system/task_* 实时更新；重新打开的会话从 Claude Code 保存的文件读出以前的：
//   <会话目录>/workflows/*.json                 每次多智能体编排的结果
//   <会话目录>.jsonl 里 Agent 工具的结果         子智能体的模型和总数
//   <会话目录>/subagents/agent-<id>.jsonl       子智能体自己的对话
//   <会话目录>/subagents/workflows/<run>/agent-<id>.jsonl   编排里智能体的对话
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRun, AgentRuns, Item, WorkflowRun } from '@pixelsky/protocol'
import { completeToolItem, toolItem } from './tools'
import { obj, num, str } from './shape'

type Msg = Record<string, unknown>
const arr = (v: unknown): Msg[] => (Array.isArray(v) ? (v as Msg[]) : [])

/** 会话记录文件最多读这么大（太大的跳过，避免卡住主进程） */
const MAX_FILE = 64 * 1024 * 1024
/** 子智能体会话最多给这么多条 */
const TRANSCRIPT_ITEMS = 600

function emptyAgent(): AgentRun {
  return {
    id: '',
    label: '',
    type: '',
    model: '',
    state: '',
    startedAt: 0,
    durationMs: 0,
    tokens: 0,
    toolCalls: 0,
    phase: null,
    prompt: '',
    result: '',
    toolUseId: null,
  }
}

/** workflow_progress 里的一个智能体 */
function workflowAgent(item: Msg): AgentRun {
  return {
    ...emptyAgent(),
    id: str(item.agentId),
    label: str(item.label),
    model: str(item.model),
    state: str(item.state),
    startedAt: num(item.startedAt),
    durationMs: num(item.durationMs),
    tokens: num(item.tokens),
    toolCalls: num(item.toolCalls),
    phase: typeof item.phaseIndex === 'number' ? item.phaseIndex : null,
    prompt: str(item.promptPreview),
    result: str(item.resultPreview) || str(item.error),
  }
}

function phasesAndAgents(progress: unknown): Pick<WorkflowRun, 'phases' | 'agents'> {
  const items = arr(progress)
  return {
    phases: items.filter(i => i.type === 'workflow_phase').map(i => ({ index: num(i.index), title: str(i.title) })),
    agents: items.filter(i => i.type === 'workflow_agent').map(workflowAgent),
  }
}

/**
 * 读会话记录文件的每一行。keep：先用整行字符串判断要不要这一行，不要的不 JSON.parse
 * （记录里带图片的行很大，解析一遍白白花时间和内存）
 */
function readRows(file: string, keep?: (line: string) => boolean): Msg[] {
  try {
    if (statSync(file).size > MAX_FILE) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .flatMap(line => {
        if (!line.trim() || (keep && !keep(line))) return []
        try {
          return [JSON.parse(line) as Msg]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export class Runs {
  private workflows: WorkflowRun[] = []
  private agents: AgentRun[] = []

  snapshot(): AgentRuns {
    return { workflows: this.workflows.map(w => ({ ...w })), agents: this.agents.map(a => ({ ...a })) }
  }

  get empty(): boolean {
    return this.workflows.length === 0 && this.agents.length === 0
  }

  /** task_started：多智能体编排或子智能体开始；其他任务类型返回 false */
  started(frame: Msg): boolean {
    const id = str(frame.task_id)
    const kind = str(frame.task_type)
    const toolUseId = str(frame.tool_use_id) || null
    if (kind === 'local_workflow') {
      this.workflows = this.workflows.filter(w => w.id !== id)
      this.workflows.push({
        id,
        name: str(frame.workflow_name),
        description: str(frame.description),
        status: 'running',
        startedAt: Date.now(),
        durationMs: 0,
        tokens: 0,
        toolCalls: 0,
        phases: [],
        agents: [],
        toolUseId,
      })
      return true
    }
    if (kind === 'local_agent') {
      this.agents = this.agents.filter(a => a.id !== id)
      this.agents.push({
        ...emptyAgent(),
        id,
        label: str(frame.description),
        type: str(frame.subagent_type),
        state: 'running',
        startedAt: Date.now(),
        prompt: str(frame.prompt),
        toolUseId,
      })
      return true
    }
    return false
  }

  /** task_progress：编排的完整智能体列表，或子智能体的用量 */
  progress(frame: Msg): boolean {
    const id = str(frame.task_id)
    const usage = obj(frame.usage)
    const w = this.workflows.find(x => x.id === id)
    if (w) {
      if (frame.workflow_progress !== undefined && frame.workflow_progress !== null)
        Object.assign(w, phasesAndAgents(frame.workflow_progress))
      w.tokens = num(usage.total_tokens) || w.tokens
      w.toolCalls = num(usage.tool_uses) || w.toolCalls
      w.durationMs = num(usage.duration_ms) || w.durationMs
      return true
    }
    const a = this.agents.find(x => x.id === id)
    if (a) {
      a.tokens = num(usage.total_tokens) || a.tokens
      a.toolCalls = num(usage.tool_uses) || a.toolCalls
      a.durationMs = num(usage.duration_ms) || a.durationMs
      if (str(frame.summary)) a.result = str(frame.summary)
      return true
    }
    return false
  }

  /** task_notification：结束 */
  finished(frame: Msg): boolean {
    const id = str(frame.task_id)
    const usage = obj(frame.usage)
    const run: WorkflowRun | AgentRun | undefined =
      this.workflows.find(x => x.id === id) ?? this.agents.find(x => x.id === id)
    if (!run) return false
    const status = str(frame.status) || 'completed'
    if ('phases' in run) run.status = status
    else {
      run.state = status
      if (str(frame.summary)) run.result = str(frame.summary)
    }
    if (Object.keys(usage).length > 0) {
      run.tokens = num(usage.total_tokens)
      run.toolCalls = num(usage.tool_uses)
      run.durationMs = num(usage.duration_ms)
    }
    return true
  }

  /** Agent 工具的结果（tool_use_result）：补上子智能体的模型和总数 */
  agentResult(result: Msg): boolean {
    const a = this.agents.find(x => x.id === str(result.agentId))
    if (!a) return false
    if (str(result.resolvedModel)) a.model = str(result.resolvedModel)
    if (typeof result.totalTokens === 'number') {
      a.tokens = result.totalTokens
      a.toolCalls = num(result.totalToolUseCount)
      a.durationMs = num(result.totalDurationMs)
      a.state = 'completed'
    }
    return true
  }

  /** 进程关掉时还在跑的标成已停止 */
  stopAll(): boolean {
    let changed = false
    for (const w of this.workflows) {
      if (w.status === 'running') {
        w.status = 'stopped'
        changed = true
      }
    }
    for (const a of this.agents) {
      if (a.state === 'running') {
        a.state = 'stopped'
        changed = true
      }
    }
    return changed
  }

  /** 把以前保存的放在实时数据前面（同 id 以实时的为准） */
  seed(saved: AgentRuns): void {
    const liveW = new Set(this.workflows.map(w => w.id))
    const liveA = new Set(this.agents.map(a => a.id))
    this.workflows = [...saved.workflows.filter(w => !liveW.has(w.id)), ...this.workflows]
    this.agents = [...saved.agents.filter(a => !liveA.has(a.id)), ...this.agents]
  }
}

/**
 * loadSavedRuns 只用到两类行：带 toolUseResult 的（启动编排的结果、Agent 工具的结果和总数），
 * 以及含 Agent / Task 工具调用的 assistant 行（取说明和任务）。其余行（普通对话、图片）不用解析。
 * 这里按子串粗筛，宁可多放进来：改动 loadSavedRuns 读的字段时要同步这里
 */
const savedRunsRow = (line: string): boolean =>
  line.includes('toolUseResult') || line.includes('"Agent"') || line.includes('"Task"')

/** 从 Claude Code 保存的文件读出以前的编排和子智能体（sessionDir 是 <会话 id> 目录，旁边是 <会话 id>.jsonl） */
export function loadSavedRuns(sessionDir: string): AgentRuns {
  const workflows: WorkflowRun[] = []
  const wfDir = join(sessionDir, 'workflows')
  let names: string[] = []
  try {
    names = readdirSync(wfDir).filter(n => n.endsWith('.json'))
  } catch {
    // 没有编排
  }
  for (const n of names) {
    let w: Msg
    try {
      w = JSON.parse(readFileSync(join(wfDir, n), 'utf8')) as Msg
    } catch {
      continue
    }
    workflows.push({
      id: str(w.taskId),
      name: str(w.workflowName),
      description: str(w.summary),
      status: str(w.status) || 'completed',
      startedAt: num(w.startTime),
      durationMs: num(w.durationMs),
      tokens: num(w.totalTokens),
      toolCalls: num(w.totalToolCalls),
      toolUseId: null,
      ...phasesAndAgents(w.workflowProgress),
    })
  }

  const rows = readRows(`${sessionDir}.jsonl`, savedRunsRow)
  // 启动编排的 Workflow 工具调用（按任务 id 对应）
  for (const row of rows) {
    const launched = obj(row.toolUseResult)
    if (launched.taskType !== 'local_workflow') continue
    const call = str(obj(arr(obj(row.message).content)[0]).tool_use_id)
    const w = workflows.find(x => x.id === str(launched.taskId))
    if (w && call) w.toolUseId = call
  }
  workflows.sort((a, b) => a.startedAt - b.startedAt)

  // Agent 工具调用，以及带总数的结果
  const labels = new Map<string, { label: string; type: string; prompt: string }>()
  const agents: AgentRun[] = []
  for (const row of rows) {
    const result = obj(row.toolUseResult)
    for (const block of arr(obj(row.message).content)) {
      if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
        const input = obj(block.input)
        labels.set(str(block.id), {
          label: str(input.description),
          type: str(input.subagent_type),
          prompt: str(input.prompt),
        })
      }
      if (block.type !== 'tool_result' || typeof result.totalTokens !== 'number') continue
      const id = str(result.agentId)
      if (!id || agents.some(a => a.id === id)) continue
      const call = str(block.tool_use_id)
      const meta = labels.get(call) ?? { label: '', type: '', prompt: '' }
      const duration = num(result.totalDurationMs)
      const ended = Date.parse(str(row.timestamp)) || 0
      agents.push({
        ...emptyAgent(),
        id,
        label: meta.label,
        type: meta.type,
        prompt: meta.prompt.slice(0, 400),
        model: str(result.resolvedModel),
        state: str(result.status) || 'completed',
        startedAt: ended ? Math.max(0, ended - duration) : 0,
        durationMs: duration,
        tokens: result.totalTokens,
        toolCalls: num(result.totalToolUseCount),
        toolUseId: call || null,
      })
    }
  }
  return { workflows, agents }
}

/** 子智能体的对话文件 */
function agentFile(sessionDir: string, agentId: string): string | null {
  if (!/^[A-Za-z0-9]+$/.test(agentId)) return null
  const name = `agent-${agentId}.jsonl`
  const direct = join(sessionDir, 'subagents', name)
  if (existsSync(direct)) return direct
  try {
    for (const run of readdirSync(join(sessionDir, 'subagents', 'workflows'))) {
      const p = join(sessionDir, 'subagents', 'workflows', run, name)
      if (existsSync(p)) return p
    }
  } catch {
    // 没有编排目录
  }
  return null
}

/** 编排智能体的任务前面有一段框架说明，真正的任务在「The computed task text follows:」之后、缩进两格 */
function taskText(text: string): string {
  const mark = 'The computed task text follows:\n'
  const i = text.indexOf(mark)
  if (i < 0) return text
  return text
    .slice(i + mark.length)
    .split('\n')
    .map(l => (l.startsWith('  ') ? l.slice(2) : l))
    .join('\n')
}

export interface TranscriptItemsOptions {
  /** 条目 id：'seq' 按序号（user-1、assistant-2……）；'uuid' 用户条目是行的 uuid，其余是 imp-<uuid>-<块序号>，工具用 tool_use 的 id */
  ids?: 'seq' | 'uuid'
  /** 去掉编排智能体任务前面的框架说明（taskText） */
  task?: boolean
  /** 只留最后这么多条 */
  limit?: number
  /** 接管一类行的转换（导入终端会话用，docs/ui/claude-resume.md §4.2）；子智能体不传 */
  hooks?: {
    /** 一行 user 记录里用户文字对应的条目（tool_result 仍按默认补全工具条目）；传了就不再走默认的用户文字处理 */
    user?: (row: Msg) => Item[]
    /** assistant 的文字块要不要跳过 */
    skipText?: (row: Msg, text: string) => boolean
    /** system 行对应的条目（compact_boundary 等） */
    system?: (row: Msg) => Item[]
  }
  /** 并行调用的兄弟结果不在传进来的行里：按 tool_use_id 找装着它的 tool_result 那一行 */
  result?: (toolUseId: string) => Msg | undefined
  /** 到最后都没有结果的工具标成 interrupted */
  closeTools?: boolean
  /** 工具结果里的图片不要（items.jsonl 会变得很大） */
  noImages?: boolean
}

const dropImages = (item: Item): Item => {
  if (item.kind !== 'tool' || !item.images) return item
  const { images, ...rest } = item
  void images
  return rest
}

/** 把 Claude Code 的记录行（user / assistant 的消息）转成条目 */
export function transcriptItems(rows: readonly Msg[], cwd: string, opts: TranscriptItemsOptions = {}): Item[] {
  const items: Item[] = []
  const tools = new Map<string, number>()
  const byUuid = opts.ids === 'uuid'
  const hooks = opts.hooks
  let n = 0
  const seq = (p: string) => `${p}-${++n}`
  const plain = opts.task ? taskText : (t: string) => t
  const complete = (at: number, block: Msg, row: Msg) => {
    const done = completeToolItem(items[at], block.content, block.is_error === true, row.toolUseResult)
    items[at] = opts.noImages ? dropImages(done) : done
  }
  for (const row of rows) {
    const content = obj(row.message).content
    const uuid = str(row.uuid)
    const id = (p: string, i: number) => (byUuid && uuid ? `imp-${uuid}-${i}` : seq(p))
    if (row.type === 'user') {
      const createdAt = Date.parse(str(row.timestamp)) || 0
      if (hooks?.user) items.push(...hooks.user(row))
      else if (typeof content === 'string') {
        items.push({ kind: 'user', id: byUuid && uuid ? uuid : seq('user'), text: plain(content), createdAt })
        continue
      }
      let texts = 0
      for (const block of arr(content)) {
        if (block.type === 'text' && str(block.text).trim() && !hooks?.user) {
          items.push({
            kind: 'user',
            id: byUuid && uuid ? (texts++ === 0 ? uuid : `imp-${uuid}-${texts}`) : seq('user'),
            text: plain(str(block.text)),
            createdAt,
          })
        } else if (block.type === 'tool_result') {
          const at = tools.get(str(block.tool_use_id))
          if (at !== undefined) complete(at, block, row)
        }
      }
    } else if (row.type === 'assistant') {
      arr(content).forEach((block, i) => {
        if (block.type === 'text' && str(block.text).trim()) {
          if (hooks?.skipText?.(row, str(block.text))) return
          items.push({ kind: 'assistant', id: id('assistant', i), text: str(block.text), status: 'completed' })
        } else if (block.type === 'thinking' && str(block.thinking).trim()) {
          items.push({ kind: 'reasoning', id: id('reasoning', i), text: str(block.thinking), status: 'completed' })
        } else if (block.type === 'tool_use') {
          const toolId = str(block.id) || id('tool', i)
          tools.set(toolId, items.length)
          items.push(toolItem(toolId, str(block.name), obj(block.input), cwd))
        }
      })
    } else if (row.type === 'system' && hooks?.system) {
      items.push(...hooks.system(row))
    }
  }
  for (const [toolId, at] of tools) {
    const item = items[at]
    if (!('status' in item) || item.status !== 'running') continue
    const row = opts.result?.(toolId)
    const block =
      row && arr(obj(row.message).content).find(b => b.type === 'tool_result' && str(b.tool_use_id) === toolId)
    if (row && block) complete(at, block, row)
    else if (opts.closeTools) items[at] = completeToolItem(item, '', false, undefined, 'interrupted')
  }
  return opts.limit ? items.slice(-opts.limit) : items
}

/** 读一个子智能体的对话，转成条目（只读显示用） */
export function loadSubagentTranscript(sessionDir: string, agentId: string, cwd: string): Item[] {
  const file = agentFile(sessionDir, agentId)
  if (!file) throw new Error('这个子智能体还没有保存会话')
  return transcriptItems(readRows(file), cwd, { task: true, limit: TRANSCRIPT_ITEMS })
}
