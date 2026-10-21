// Claude Code 的工具调用 → 统一条目（docs/engines.md §9「工具归类」）
import { isAbsolute, relative } from 'node:path'
import type {
  AlwaysScope,
  ApprovalRequest,
  FileChange,
  ImageAttachment,
  Item,
  ItemStatus,
  Question,
  TodoStep,
  ToolKind,
} from '@pixelsky/protocol'
import { IMAGE_PLACEHOLDER } from '@pixelsky/protocol'
import { diffAdded, diffFromHunks, diffText, type PatchHunk } from '../diff'
import { MAX_OUTPUT, clip } from '../output'
import { cut } from '../text'
import { str } from './shape'

export { clip }

type Input = Record<string, unknown>
/** 参数里的数组只取对象元素：模型偶尔给 null 或字符串，直接取字段会抛错（审查报告 2026-10-14） */
const objects = (value: unknown): Input[] =>
  Array.isArray(value) ? value.filter((v): v is Input => !!v && typeof v === 'object' && !Array.isArray(v)) : []

/** 工作目录里的文件显示相对路径 */
export function displayPath(p: string, cwd: string): string {
  if (!p) return p
  if (!isAbsolute(p)) return p
  const rel = relative(cwd, p)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : p
}

const COMMAND_TOOLS = new Set(['Bash', 'PowerShell'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function fileChangesFromInput(name: string, input: Input, cwd: string): FileChange[] {
  const path = displayPath(str(input.file_path) || str(input.notebook_path), cwd)
  if (name === 'Write') {
    const d = diffAdded(str(input.content))
    return [{ path, kind: 'add', newText: str(input.content).slice(0, MAX_OUTPUT), ...d }]
  }
  if (name === 'Edit') {
    const d = diffText(str(input.old_string), str(input.new_string))
    return [{ path, kind: 'update', newText: str(input.new_string).slice(0, MAX_OUTPUT), ...d }]
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const parts = objects(input.edits).map(e => diffText(str(e.old_string), str(e.new_string)))
    return [
      {
        path,
        kind: 'update',
        newText: str(objects(input.edits)[0]?.new_string).slice(0, MAX_OUTPUT),
        diff: parts.map(p => p.diff).join('\n'),
        added: parts.reduce((n, p) => n + p.added, 0),
        removed: parts.reduce((n, p) => n + p.removed, 0),
      },
    ]
  }
  return [{ path, kind: 'update', diff: '', added: 0, removed: 0 }]
}

function toolTitle(name: string, input: Input, cwd: string): { tool: ToolKind; title: string } {
  switch (name) {
    case 'Read':
      return { tool: 'read', title: displayPath(str(input.file_path), cwd) }
    case 'LS':
      return { tool: 'read', title: displayPath(str(input.path), cwd) }
    case 'Glob':
      return { tool: 'search', title: str(input.pattern) }
    case 'Grep':
      return {
        tool: 'search',
        title: [str(input.pattern), input.path ? displayPath(str(input.path), cwd) : ''].filter(Boolean).join(' · '),
      }
    case 'WebFetch':
      return { tool: 'web', title: str(input.url) }
    case 'WebSearch':
      return { tool: 'web', title: str(input.query) }
    case 'Task':
    case 'Agent':
      return { tool: 'task', title: str(input.description) || str(input.subagent_type) || '子任务' }
    case 'Workflow':
      return { tool: 'task', title: str(input.description) || str(input.name) || '多智能体编排' }
    case 'Skill':
      return { tool: 'other', title: [str(input.skill), str(input.args)].filter(Boolean).join(' · ') }
    // 动作（提问 / 提交计划）由界面按工具名翻译，标题放内容：第一个问题、计划的第一行
    case 'AskUserQuestion':
      return {
        tool: 'other',
        title: str((Array.isArray(input.questions) ? (input.questions[0] as Input) : {})?.question),
      }
    case 'ExitPlanMode':
      return {
        tool: 'other',
        title:
          str(input.plan)
            .split('\n')
            .map(l => l.replace(/^#+\s*/, '').trim())
            .find(Boolean) ?? '',
      }
  }
  if (name.startsWith('mcp__')) {
    const [, server = '', tool = ''] = name.split('__')
    return { tool: 'mcp', title: `${server} · ${tool}` }
  }
  const brief = JSON.stringify(input)
  return { tool: 'other', title: brief.length > 80 ? `${cut(brief, 0, 80)}…` : brief }
}

function todoSteps(input: Input): TodoStep[] {
  if (!Array.isArray(input.todos)) return []
  return objects(input.todos).map(t => ({
    text: str(t.content) || str(t.activeForm),
    status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
  }))
}

/**
 * 工具调用开始：模型给出了完整参数。subagent：调用它的子智能体名字；subagentCall：派出它的 Agent 工具调用 id
 * （主智能体调用时都不传）
 */
export function toolItem(
  id: string,
  name: string,
  input: Input,
  cwd: string,
  subagent?: string,
  subagentCall?: string,
): Item {
  const item = baseToolItem(id, name, input, cwd)
  if (subagent && (item.kind === 'command' || item.kind === 'file_change' || item.kind === 'tool'))
    return { ...item, subagent, ...(subagentCall ? { subagentCall } : {}) }
  return item
}

function baseToolItem(id: string, name: string, input: Input, cwd: string): Item {
  if (COMMAND_TOOLS.has(name)) {
    return {
      kind: 'command',
      id,
      command: str(input.command),
      description: str(input.description) || null,
      output: '',
      exitCode: null,
      status: 'running',
    }
  }
  if (EDIT_TOOLS.has(name)) {
    return { kind: 'file_change', id, changes: fileChangesFromInput(name, input, cwd), status: 'running' }
  }
  if (name === 'TodoWrite') {
    return { kind: 'todo', id, steps: todoSteps(input), status: 'running' }
  }
  const { tool, title } = toolTitle(name, input, cwd)
  // 提交计划：计划正文留在这一行里，批准之后对话里还能展开看
  const output = name === 'ExitPlanMode' ? str(input.plan) : ''
  return { kind: 'tool', id, tool, name, title, output, status: 'running' }
}

const IMAGE_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** 工具结果里的图片最多带这么多（base64 字符，所有图片合计）；超出的仍只显示「[图片]」 */
const MAX_RESULT_IMAGES = 3_000_000

/** tool_result 里的图片（例如 Read 了一张图片）：对话里显示缩略图 */
export function resultImages(content: unknown, id: string): ImageAttachment[] {
  if (!Array.isArray(content)) return []
  const images: ImageAttachment[] = []
  let total = 0
  for (const block of content as Input[]) {
    if (block?.type !== 'image') continue
    const source = (block.source ?? {}) as Input
    const mediaType = str(source.media_type)
    const data = str(source.data)
    if (source.type !== 'base64' || !IMAGE_TYPES.has(mediaType) || !data || total + data.length > MAX_RESULT_IMAGES)
      continue
    total += data.length
    images.push({
      id: `${id}-img${images.length}`,
      name: '',
      mediaType: mediaType as ImageAttachment['mediaType'],
      bytes: Math.floor((data.length * 3) / 4),
      width: 0,
      height: 0,
      dataBase64: data,
    })
  }
  return images
}

/** Claude 的命令失败时，结果正文第一行是「Exit code N」 */
function exitCodeOf(text: string): number | null {
  const m = /^Exit code (\d+)/.exec(text)
  return m ? Number(m[1]) : null
}

/** tool_result 的 content：字符串，或 [{type:'text',text}, {type:'image',…}] */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => {
        const b = c as Input
        if (b.type === 'text') return str(b.text)
        if (b.type === 'image') return IMAGE_PLACEHOLDER
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 工具调用结束：拿到 tool_result（以及 Claude 附带的结构化结果 tool_use_result） */
export function completeToolItem(
  item: Item,
  content: unknown,
  isError: boolean,
  structured: unknown,
  status?: ItemStatus,
): Item {
  const text = clip(resultText(content))
  const finalStatus: ItemStatus = status ?? (isError ? 'failed' : 'completed')
  const r = (structured && typeof structured === 'object' ? structured : {}) as Input
  switch (item.kind) {
    case 'command': {
      const stdout = str(r.stdout)
      const stderr = str(r.stderr)
      const output = stdout || stderr ? clip([stdout, stderr].filter(Boolean).join('\n')) : text
      const exitCode = isError ? exitCodeOf(text) : finalStatus === 'completed' ? 0 : item.exitCode
      return { ...item, output, exitCode, status: finalStatus }
    }
    case 'file_change': {
      if (isError) return { ...item, status: finalStatus }
      const hunks = Array.isArray(r.structuredPatch) ? (r.structuredPatch as PatchHunk[]) : []
      if (item.changes.length === 1) {
        const [c] = item.changes
        if (r.type === 'create') {
          return { ...item, changes: [{ ...c, kind: 'add', ...diffAdded(str(r.content)) }], status: finalStatus }
        }
        if (hunks.length > 0) {
          return { ...item, changes: [{ ...c, kind: 'update', ...diffFromHunks(hunks) }], status: finalStatus }
        }
      }
      return { ...item, status: finalStatus }
    }
    case 'tool': {
      const images = resultImages(content, item.id)
      // 提交计划的结果只是「已批准」之类的话：保留计划正文
      const output = item.name === 'ExitPlanMode' && item.output ? item.output : text
      return { ...item, output, status: finalStatus, ...(images.length ? { images } : {}) }
    }
    case 'todo':
      return { ...item, status: finalStatus }
    default:
      return item
  }
}

function questionsFromInput(input: Input): Question[] {
  if (!Array.isArray(input.questions)) return []
  return objects(input.questions).map(q => ({
    question: str(q.question),
    header: str(q.header),
    multiSelect: q.multiSelect === true,
    // Claude Code 自己的界面每题都带「其他」可以自由输入，模型发问也按这个前提
    allowOther: true,
    options: Array.isArray(q.options)
      ? objects(q.options).map(o => ({ label: str(o.label), description: str(o.description) }))
      : [],
  }))
}

/** Claude Code 的「始终允许」能保存到的范围 */
export const CLAUDE_ALWAYS_SCOPES: AlwaysScope[] = ['session', 'project', 'user']

/** 范围 → updatedPermissions 的 destination */
const DESTINATION: Record<AlwaysScope, string> = { session: 'session', project: 'localSettings', user: 'userSettings' }

/**
 * 「始终允许」要回传的权限规则（参考 JuCode always_permissions）：
 * 取 CLI 建议里「添加允许规则」的那些，把保存位置换成所选范围；没有建议时：
 * - 命令（Bash / PowerShell）只放行这一条完全相同的命令。CLI 不给建议的多半是复合命令、重定向这类它故意不归纳的，
 *   退回成只有工具名的规则等于以后所有命令都不再询问；命令为空就只放行这一次，不存规则
 * - 其他工具允许整个工具（写文件、某个 MCP 工具这类，工具名本身就是合适的粒度）
 */
export function alwaysPermissions(
  toolName: string,
  suggestions: unknown[],
  scope: AlwaysScope,
  input: Input = {},
): unknown[] {
  const destination = DESTINATION[scope]
  const rules = suggestions
    .map(x => (x && typeof x === 'object' ? (x as Input) : {}))
    .filter(x => x.type === 'addRules' && x.behavior === 'allow' && Array.isArray(x.rules))
    .map(x => ({ ...x, destination }))
  if (rules.length > 0) return rules
  if (COMMAND_TOOLS.has(toolName)) {
    const command = str(input.command).trim()
    return command
      ? [{ type: 'addRules', rules: [{ toolName, ruleContent: command }], behavior: 'allow', destination }]
      : []
  }
  return [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination }]
}

/** can_use_tool 审批请求 → 统一审批卡片 */
export function approvalFor(
  requestId: string,
  toolName: string,
  input: Input,
  toolUseId: string | null,
  cwd: string,
): ApprovalRequest {
  const common = { requestId, itemId: toolUseId, alwaysScopes: CLAUDE_ALWAYS_SCOPES }
  if (COMMAND_TOOLS.has(toolName)) {
    return {
      ...common,
      kind: 'command',
      title: '运行命令',
      command: str(input.command),
      description: str(input.description) || undefined,
    }
  }
  if (EDIT_TOOLS.has(toolName)) {
    const changes = fileChangesFromInput(toolName, input, cwd)
    return { ...common, kind: 'file_change', title: toolName === 'Write' ? '写入文件' : '修改文件', changes }
  }
  if (toolName === 'AskUserQuestion') {
    return {
      ...common,
      kind: 'question',
      title: 'Claude 想问你',
      questions: questionsFromInput(input),
      alwaysScopes: [],
    }
  }
  if (toolName === 'ExitPlanMode') {
    return { ...common, kind: 'plan', title: '计划已就绪，要开始执行吗？', plan: str(input.plan), alwaysScopes: [] }
  }
  const { title } = toolTitle(toolName, input, cwd)
  return { ...common, kind: 'tool', title: `使用 ${toolName}`, toolName, input, description: title }
}
