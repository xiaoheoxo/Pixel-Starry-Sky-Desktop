// agy acp 的 session/update → 我们的条目（docs/antigravity-engine.md §7 实测）。纯翻译，不碰进程
import { randomUUID } from 'node:crypto'
import { relative, isAbsolute } from 'node:path'
import type {
  ApprovalRequest,
  EngineEvent,
  FileChange,
  Item,
  ItemStatus,
  Question,
  SkillCommand,
  TodoStep,
  ToolKind,
  TurnUsage,
} from '@pixelsky/protocol'
import { diffAdded, diffText } from '../diff'

type Msg = Record<string, unknown>
const obj = (v: unknown): Msg => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Msg) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** 模型出错时 agy 不报错，把错误当一段回复文字发（§7「一轮」） */
export const AGY_ERROR_PREFIX = '⚠ agent executor error'

/** agy 的路径一会儿 D:\…、一会儿 D:/…、完成时 /D:/…：统一成本机写法 */
export function agyPath(p: string): string {
  const fixed = p.replace(/^\/([A-Za-z]:)/, '$1')
  return /^[A-Za-z]:/.test(fixed) ? fixed.replace(/\//g, '\\') : fixed
}

/** 命令输出前面的「Created At / Completed At / Command exited with code N. / Command output:」抬头去掉 */
export function commandOutput(raw: string): string {
  const i = raw.indexOf('Command output:\n')
  return (i >= 0 ? raw.slice(i + 'Command output:\n'.length) : raw).replace(/\r\n/g, '\n').replace(/\n$/, '')
}

/** available_commands_update 的列表 → 「/」菜单的命令 */
export function agyCommands(list: unknown): SkillCommand[] {
  return (Array.isArray(list) ? list : []).flatMap(c => {
    const o = (c ?? {}) as Record<string, unknown>
    return typeof o.name === 'string' && o.name
      ? [
          {
            name: o.name,
            description: typeof o.description === 'string' ? o.description : '',
            source: 'engine' as const,
          },
        ]
      : []
  })
}

/** agy 自己的任务清单：brain/<对话>/task.md（§12 实测，不经审批）；写它的工具翻成进度卡，不算改文件 */
const TASK_FILE = /[\\/]brain[\\/][^\\/]+[\\/]task\.md$/

/** task.md 的勾选列表 → 待办：[ ] 未开始、[/] 进行中、[x] 完成；行尾 <!-- id: n --> 去掉 */
export function taskSteps(markdown: string): TodoStep[] {
  const steps: TodoStep[] = []
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[([ xX/])\]\s+(.*)$/.exec(line)
    if (!m) continue
    const text = m[2]!.replace(/<!--.*?-->/g, '').trim()
    if (text) steps.push({ text, status: m[1] === '/' ? 'in_progress' : m[1] === ' ' ? 'pending' : 'completed' })
  }
  return steps
}

const TOOL_KIND: Record<string, ToolKind> = { read: 'read', search: 'search', fetch: 'web' }

/** agy 的 ask_question（§12）：工具停在 pending、问题和选项又当回复文字发一遍，这次 prompt 就结束 */
export interface AgyQuestion {
  itemId: string
  questions: Question[]
}

/** ask_question 的参数 → 提问卡片的问题；选项是纯文字（可能带「(Recommended) 」前缀），允许自己填 */
export function agyQuestions(input: unknown): Question[] {
  return arr(obj(input).questions).map(raw => {
    const q = obj(raw)
    return {
      question: str(q.question),
      header: '',
      multiSelect: q.is_multi_select === true,
      allowOther: true,
      options: arr(q.options).map(o => ({ label: str(o), description: '' })),
    }
  })
}

interface Open {
  id: string
  kind: 'assistant' | 'reasoning'
  text: string
}

export class AgyTranslator {
  private readonly prefix = randomUUID().slice(0, 8)
  private seq = 0
  private open: Open | null = null
  /** toolCallId → 我们的条目（最新一份） */
  private readonly tools = new Map<string, Item>()
  /** 这一轮模型报的错（错误前缀的那段文字） */
  error: string | null = null
  private todoId: string | null = null
  /** 这次 prompt 里 agy 提的问题；有了之后它再发的回复文字（问题的文字版）不显示 */
  private question: AgyQuestion | null = null

  constructor(
    private readonly emit: (e: EngineEvent) => void,
    private readonly cwd: string,
  ) {}

  private nextId(kind: string): string {
    return `ag-${this.prefix}-${kind}-${++this.seq}`
  }

  /** 一条 session/update；返回值是要宿主处理的（模式变了、命令列表、上下文用量） */
  update(u: Msg): { mode?: string; commands?: SkillCommand[]; context?: { used: number; size: number } } {
    switch (str(u.sessionUpdate)) {
      case 'agent_message_chunk':
        this.text('assistant', str(obj(u.content).text))
        return {}
      case 'agent_thought_chunk':
        this.text('reasoning', str(obj(u.content).text))
        return {}
      case 'tool_call':
      case 'tool_call_update':
        this.closeText()
        this.tool(u)
        return {}
      case 'plan':
        this.closeText()
        this.plan(u)
        return {}
      case 'usage_update':
        return { context: { used: num(u.used), size: num(u.size) } }
      case 'current_mode_update':
        return { mode: str(u.currentModeId) }
      case 'available_commands_update':
        return { commands: agyCommands(u.availableCommands) }
      default:
        // user_message_chunk（回显自己的消息，宿主已经发过用户条目）、config_option_update 等不进对话
        return {}
    }
  }

  private text(kind: Open['kind'], delta: string): void {
    if (!delta) return
    if (kind === 'assistant' && this.question) return
    if (kind === 'assistant' && (this.error !== null || delta.trimStart().startsWith(AGY_ERROR_PREFIX))) {
      this.error = ((this.error ?? '') + delta).trim()
      return
    }
    if (this.open?.kind !== kind) {
      this.closeText()
      this.open = { id: this.nextId(kind === 'assistant' ? 'msg' : 'think'), kind, text: '' }
      this.emit({ type: 'item_started', item: { kind, id: this.open.id, text: '', status: 'running' } })
    }
    this.open.text += delta
    this.emit({ type: 'item_delta', itemId: this.open.id, field: 'text', delta })
  }

  private closeText(status: ItemStatus = 'completed'): void {
    const o = this.open
    if (!o) return
    this.open = null
    this.emit({ type: 'item_completed', item: { kind: o.kind, id: o.id, text: o.text, status } })
  }

  /** tool_call / tool_call_update / 权限请求里的 toolCall → 条目；没见过的 id 先开始，完成或失败时 item_completed */
  tool(u: Msg): Item {
    const callId = str(u.toolCallId)
    const task = this.taskList(u)
    if (task) return task
    if (str(u.name) === 'ask_question') return this.askQuestion(callId, u)
    const prev = this.tools.get(callId)
    const merged = { ...(prev ? (this.toolRaw.get(callId) ?? {}) : {}), ...u }
    this.toolRaw.set(callId, merged)
    const status: ItemStatus = u.status === 'completed' ? 'completed' : u.status === 'failed' ? 'failed' : 'running'
    const item = this.toolItem(prev?.id ?? 'ag-tool-' + callId, merged, status)
    this.tools.set(callId, item)
    if (status === 'running') {
      if (!prev) this.emit({ type: 'item_started', item })
    } else this.emit({ type: 'item_completed', item })
    return item
  }
  private readonly toolRaw = new Map<string, Msg>()

  private toolItem(id: string, u: Msg, status: ItemStatus): Item {
    const kind = str(u.kind)
    const input = obj(u.rawInput ?? u.args)
    const rawOut = obj(u.rawOutput)
    if (kind === 'execute') {
      const out = str(rawOut.output) || this.contentText(u)
      return {
        kind: 'command',
        id,
        command: str(input.CommandLine) || str(u.title),
        description: str(input.toolSummary) || null,
        output: commandOutput(out),
        exitCode: typeof rawOut.exit_code === 'number' ? rawOut.exit_code : null,
        status,
      }
    }
    if (kind === 'edit' || kind === 'delete') {
      const changes = this.changes(u, kind === 'delete')
      if (changes.length) return { kind: 'file_change', id, changes, status }
    }
    const path = str(obj(arr(u.locations)[0]).path)
    const name = str(u.name)
    // MCP 工具：agy 叫 mcp_<服务>_<工具>，标题是「Run mcp_…」，显示成去掉前缀的名字
    if (name.startsWith('mcp_'))
      return { kind: 'tool', id, tool: 'mcp', name, title: name.slice(4), output: this.contentText(u), status }
    return {
      kind: 'tool',
      id,
      tool: TOOL_KIND[kind] ?? 'other',
      name: str(u.name) || kind || 'tool',
      title: path ? this.show(path) : str(u.title).replace(/^File /, ''),
      output: this.contentText(u),
      status,
    }
  }

  /** 改动：content 里的 diff 块；没有时按 locations 写一条空 diff 的「修改」 */
  private changes(u: Msg, deleted: boolean): FileChange[] {
    const diffs = arr(u.content)
      .map(obj)
      .filter(c => c.type === 'diff')
    if (diffs.length)
      return diffs.map(d => {
        const oldText = typeof d.oldText === 'string' ? d.oldText : null
        const newText = str(d.newText)
        const r = deleted
          ? diffText(oldText ?? '', '')
          : oldText === null
            ? diffAdded(newText)
            : diffText(oldText, newText)
        return {
          path: this.show(str(d.path)),
          kind: deleted ? 'delete' : oldText === null ? 'add' : 'update',
          newText,
          ...r,
        }
      })
    return arr(u.locations).map(l => ({
      path: this.show(str(obj(l).path)),
      kind: deleted ? ('delete' as const) : ('update' as const),
      diff: '',
      added: 0,
      removed: 0,
    }))
  }

  private contentText(u: Msg): string {
    return arr(u.content)
      .map(obj)
      .map(c => (c.type === 'content' ? str(obj(c.content).text) : ''))
      .filter(Boolean)
      .join('\n')
  }

  /** 工作目录里的显示成相对路径 */
  private show(p: string): string {
    const abs = agyPath(p)
    if (!isAbsolute(abs)) return abs
    const rel = relative(this.cwd, abs)
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs
  }

  /** ask_question：记下问题交给会话弹卡片，条目显示成一行「提问」，等回答时再收尾 */
  private askQuestion(callId: string, u: Msg): Item {
    const id = this.tools.get(callId)?.id ?? 'ag-tool-' + callId
    const questions = agyQuestions(u.rawInput ?? u.args)
    const item: Item = {
      kind: 'tool',
      id,
      tool: 'other',
      name: 'ask_question',
      title: questions.map(q => q.question).join(' / '),
      output: '',
      status: 'running',
    }
    if (!this.tools.has(callId)) this.emit({ type: 'item_started', item })
    this.tools.set(callId, item)
    if (questions.length) {
      this.closeText()
      this.question = { itemId: id, questions }
    }
    return item
  }

  /** 这次 prompt 结束时取走提的问题（取了就清掉，回复文字恢复显示） */
  takeQuestion(): AgyQuestion | null {
    const q = this.question
    this.question = null
    return q
  }

  /** 用户回答了：提问那一行收尾，回答放进输出 */
  resolveQuestion(itemId: string, answer: string): void {
    for (const [callId, item] of this.tools)
      if (item.id === itemId && item.kind === 'tool') {
        const done: Item = { ...item, output: answer, status: 'completed' }
        this.tools.set(callId, done)
        this.emit({ type: 'item_completed', item: done })
      }
  }

  /** 写 task.md 的工具调用：内容翻成待办（失败的、读不出步骤的不更新）；不是 task.md 返回 null */
  private taskList(u: Msg): Item | null {
    const path = str(obj(arr(u.locations)[0]).path)
    if (!TASK_FILE.test(path)) return null
    const diff = arr(u.content)
      .map(obj)
      .find(c => c.type === 'diff')
    const content = diff ? str(diff.newText) : str(obj(u.rawInput ?? u.args).Content)
    const steps = taskSteps(content)
    if (u.status === 'failed' || !steps.length) {
      return { kind: 'todo', id: this.todoId ?? this.nextId('todo'), steps: [], status: 'running' }
    }
    return this.todo(steps)
  }

  /** ACP plan → 待办；同一轮里更新同一条 */
  private plan(u: Msg): void {
    this.todo(
      arr(u.entries).map(e => {
        const s = str(obj(e).status)
        return {
          text: str(obj(e).content),
          status: s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending',
        }
      }),
    )
  }

  private todo(steps: TodoStep[]): Item {
    const first = !this.todoId
    this.todoId ??= this.nextId('todo')
    const done = steps.length > 0 && steps.every(s => s.status === 'completed')
    const item: Item = { kind: 'todo', id: this.todoId, steps, status: done ? 'completed' : 'running' }
    this.emit({ type: first ? 'item_started' : 'item_completed', item })
    return item
  }

  /** 权限请求 → 审批卡片（§7「工具调用」：agy 只有允许一次 / 拒绝一次，「本会话不再询问」是我们记的） */
  approval(requestId: string, params: Msg): ApprovalRequest {
    const call = obj(params.toolCall)
    const item = this.tool({ ...call, status: 'pending' })
    // 「本会话不再询问」由会话自己记（session.ts approvalKeys）
    const base = { requestId, itemId: item.id, alwaysScopes: ['session' as const], canAllowAll: false }
    if (item.kind === 'command')
      return {
        ...base,
        kind: 'command',
        title: '运行命令',
        command: item.command,
        ...(item.description ? { description: item.description } : {}),
      }
    if (item.kind === 'file_change') return { ...base, kind: 'file_change', title: '修改文件', changes: item.changes }
    return {
      ...base,
      kind: 'tool',
      title: str(call.title) || '使用工具',
      toolName: str(call.name),
      input: call.rawInput ?? call.args,
    }
  }

  /** 一轮结束：没收尾的文字收尾，还在跑的工具按中断算 */
  finish(outcome: 'completed' | 'interrupted' | 'failed'): void {
    this.closeText(outcome === 'completed' ? 'completed' : 'interrupted')
    for (const [callId, item] of this.tools)
      if ('status' in item && item.status === 'running') {
        const done = { ...item, status: outcome === 'completed' ? 'completed' : 'interrupted' } as Item
        this.tools.set(callId, done)
        this.emit({ type: 'item_completed', item: done })
      }
    this.tools.clear()
    this.toolRaw.clear()
    this.todoId = null
    this.error = null
    this.question = null
  }
}

/** session/prompt 结果里的用量 → 这一轮的用量（inputTokens 不含缓存读，outputTokens 含思考，§7 对过总数） */
export function agyTurnUsage(usage: unknown, model: string, durationMs: number): TurnUsage {
  const u = obj(usage)
  return {
    models: {
      [model]: {
        input: num(u.inputTokens),
        cacheRead: num(u.cachedReadTokens),
        cacheWrite: num(u.cachedWriteTokens),
        output: num(u.outputTokens),
        costUsd: null,
      },
    },
    durationMs,
  }
}
