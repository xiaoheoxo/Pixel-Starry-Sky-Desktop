// 一个 Antigravity 会话 = 一个常驻的 agy acp 进程（docs/antigravity-engine.md §5、§7）。
// 启动：initialize →（有 Key 时）authenticate → session/resume（接上原来的）或 session/new → 重设模型 / 档位 / 模式
// （agy 不随会话保存它们）。一轮：session/prompt，结果在这一轮结束时回；中途的 session/update 交给翻译
import { randomUUID } from 'node:crypto'
import type {
  ApprovalDecision,
  ApprovalRequest,
  ExtensionLaunch,
  Effort,
  ImageAttachment,
  PermissionMode,
  Question,
  SessionSettings,
  TurnOutcome,
} from '@pixelsky/protocol'
import type { CloseOptions, EngineSession, Launcher, SessionContext } from '../adapter'
import { AcpConnection } from '../acp/connection'
import { AGY_ERROR_PREFIX, AgyTranslator, agyTurnUsage, type AgyQuestion } from './translate'

type Msg = Record<string, unknown>
const obj = (v: unknown): Msg => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Msg) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export interface ConfigOption {
  id: string
  currentValue: string
  options: { value: string; name: string }[]
}

/** session/new 等返回的 configOptions */
export function configOptions(v: unknown): ConfigOption[] {
  return (Array.isArray(v) ? v : []).map(o => ({
    id: str(obj(o).id),
    currentValue: str(obj(o).currentValue),
    options: (Array.isArray(obj(o).options) ? (obj(o).options as unknown[]) : []).map(x => ({
      value: str(obj(x).value),
      name: str(obj(x).name),
    })),
  }))
}

/** 我们的权限模式 ↔ agy 的模式（§7：default 要审批、accept-edits 改文件不问、plan） */
const MODE_OUT: Partial<Record<PermissionMode, string>> = {
  ask: 'default',
  edits: 'accept-edits',
  plan: 'plan',
  // 完全放行：agy 少问一些，剩下的权限请求由会话直接回允许
  full: 'accept-edits',
}
const MODE_IN: Record<string, PermissionMode> = { default: 'ask', 'accept-edits': 'edits', plan: 'plan' }

const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** 想要的档位这个模型没有：取不超过它的最高一档，都比它高就取最低一档 */
export function pickEffort(want: Effort, available: string[]): string | null {
  if (!available.length) return null
  if (available.includes(want)) return want
  const rank = (e: string): number => EFFORT_ORDER.indexOf(e as Effort)
  const lower = available.filter(a => rank(a) >= 0 && rank(a) <= rank(want)).sort((a, b) => rank(b) - rank(a))
  return lower[0] ?? available[0]!
}

/** 设置 › 本机引擎里影响 agy 进程的开关（改了宿主按 launchKey 换进程） */
export interface AgyLaunch {
  askQuestions: boolean
  autoPlan: boolean
  autoCompactPct: number | null
}

/**
 * 追加到 agy 系统提示的说明（session/new、resume 的 _meta.antigravity.systemPrompt.append，§12 实测生效）。
 * 列任务照 agy 自己的 task.md 清单（翻译成进度卡）；不让提问时禁掉 ask_question
 */
export function agySystemPrompt(launch: AgyLaunch): string {
  const parts: string[] = []
  if (launch.autoPlan)
    parts.push(`# Progress list (required by this app)
The app shows your task.md task list to the user as a live progress card; it is the only way they can see where you are.
- If the request involves 3 or more distinct actions, create the task.md list before starting, one entry per step.
- Mark an entry in progress right before you start it and done right after it is finished.
- Do not create a list for questions, explanations, or one- or two-action requests.`)
  if (!launch.askQuestions)
    parts.push(`# Questions
Do not use the ask_question tool. When a decision is needed, choose a reasonable option yourself and state your assumptions in the reply.`)
  return parts.join('\n\n')
}

/** 卡片上的回答 → 发回给 agy 的话；跳过（deny）返回 null */
export function answerText(questions: Question[], decision: ApprovalDecision): string | null {
  if (decision.type !== 'answer') return null
  const lines = questions.map(q => `${q.question}\n→ ${decision.answers[q.question] ?? '（没有回答）'}`)
  return lines.join('\n\n')
}

/** 扩展 / 应用的 MCP → ACP 的 mcpServers：stdio 的 env 和 http / sse 的 headers 都是 {name, value} 列表 */
export function acpMcpServers(list: NonNullable<ExtensionLaunch['acpMcp']>): Msg[] {
  const pairs = (o: Record<string, string> = {}): Msg[] => Object.entries(o).map(([name, value]) => ({ name, value }))
  return list.flatMap((s): Msg[] =>
    s.type === 'stdio'
      ? s.command
        ? [{ name: s.name, command: s.command, args: s.args ?? [], env: pairs(s.env) }]
        : []
      : s.url
        ? [{ type: s.type, name: s.name, url: s.url, headers: pairs(s.headers) }]
        : [],
  )
}

/** 一轮不设上限（agy 自己的 --print-timeout 也默认不限）；24 小时只是兜底 */
const TURN_TIMEOUT = 24 * 60 * 60_000

interface Active {
  id: string
  started: number
  promptSent: boolean
}

interface PendingApproval {
  options: { optionId: string; kind: string }[]
  /** 「本会话不再询问」记下的键 */
  keys: string[]
  resolve(outcome: Msg): void
}

/**
 * 「本会话不再询问」按什么算同一件事（照 Codex 的 acceptForSession）：同一条命令、同样的文件、同一个工具。
 * agy 只有允许一次 / 拒绝一次，记在我们这边，之后同样的请求直接回允许
 */
export function approvalKeys(request: ApprovalRequest): string[] {
  if (request.kind === 'command') return ['command:' + (request.command ?? '').trim()]
  if (request.kind === 'file_change') return (request.changes ?? []).map(c => 'file:' + c.path)
  return ['tool:' + (request.toolName || request.title)]
}

export class AntigravitySession implements EngineSession {
  private conn: AcpConnection | null = null
  private opening: Promise<void> | null = null
  private sessionId: string | null = null
  private options: ConfigOption[] = []
  private settings: SessionSettings
  private active: Active | null = null
  private closed = false
  private readonly translator: AgyTranslator
  private readonly approvals = new Map<string, PendingApproval>()
  /** 「本会话不再询问」允许过的（approvalKeys） */
  private readonly allowedForSession = new Set<string>()
  /** agy 的 ask_question 变成的提问卡片：回答（或拒绝）时 resolve，停止时 resolve null */
  private readonly questions = new Map<string, (d: ApprovalDecision | null) => void>()
  private turnWaiters: Array<() => void> = []
  private totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  /** 最近一次 usage_update：自动压缩按它判断 */
  private lastContext: { used: number; size: number } | null = null

  constructor(
    private readonly launcher: Launcher,
    private readonly env: NodeJS.ProcessEnv,
    private readonly ctx: SessionContext,
    private readonly args: string[] = [],
    private readonly launch: AgyLaunch = { askQuestions: true, autoPlan: true, autoCompactPct: null },
  ) {
    this.settings = { ...ctx.record() }
    this.translator = new AgyTranslator(e => this.ctx.emit(e), ctx.record().cwd)
  }

  private open(): Promise<void> {
    if (this.conn && this.sessionId) return Promise.resolve()
    this.opening ??= this.start().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async start(): Promise<void> {
    const record = this.ctx.record()
    const conn = new AcpConnection(this.launcher, ['acp', ...this.args], record.cwd, this.env, {
      notification: (method, params) => this.notification(method, params),
      request: (method, params) => (method === 'session/request_permission' ? this.permission(params) : undefined),
      exit: (_code, stderr) => this.exited(stderr),
    })
    this.conn = conn
    try {
      await conn.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'pixelsky', version: '1' },
      })
      if (this.env.GEMINI_API_KEY?.trim()) await conn.request('authenticate', { methodId: 'gemini-api-key' })
      // 应用自己的只读 MCP（查看别的会话、对话历史、频道工具）走会话参数；系统提示追加说明
      const append = agySystemPrompt(this.launch)
      const params = {
        cwd: record.cwd,
        mcpServers: acpMcpServers(this.ctx.extensions?.acpMcp ?? []),
        ...(append ? { _meta: { antigravity: { systemPrompt: { append } } } } : {}),
      }
      let result: Msg | null = null
      if (record.engineSessionId)
        try {
          // resume 不回放历史（load 会回放），我们自己存着对话
          result = obj(await conn.request('session/resume', { ...params, sessionId: record.engineSessionId }))
          this.sessionId = record.engineSessionId
        } catch (error) {
          this.ctx.emit({
            type: 'item_completed',
            item: {
              kind: 'notice',
              id: 'ag-lost-' + randomUUID().slice(0, 8),
              level: 'warn',
              text: '原来的 Antigravity 会话接不上，已经开了新会话（之前的对话它看不到）',
              detail: (error as Error).message,
            },
          })
        }
      if (!this.sessionId) {
        result = obj(await conn.request('session/new', params))
        this.sessionId = str(result.sessionId)
        this.ctx.setEngineSessionId(this.sessionId)
      }
      this.options = configOptions(result?.configOptions)
      await this.apply(this.settings, true)
    } catch (error) {
      this.sessionId = null
      this.conn = null
      void conn.close(500)
      throw error
    }
  }

  /** 把模型、档位、模式设到 agy 上（agy 不随会话保存，接上后都要重设） */
  private async apply(want: Partial<SessionSettings>, all = false): Promise<void> {
    const conn = this.conn
    const sessionId = this.sessionId
    if (!conn || !sessionId) return
    const set = async (configId: string, value: string): Promise<void> => {
      const current = this.options.find(o => o.id === configId)
      if (!current || current.currentValue === value || !current.options.some(o => o.value === value)) return
      const r = obj(await conn.request('session/set_config_option', { sessionId, configId, value }))
      this.options = configOptions(r.configOptions)
    }
    if ((all || 'model' in want) && this.settings.model) await set('model', this.settings.model)
    if ((all || 'effort' in want || 'model' in want) && this.settings.effort) {
      const levels = this.options.find(o => o.id === 'thought_level')?.options.map(o => o.value) ?? []
      const level = pickEffort(this.settings.effort, levels)
      if (level) {
        await set('thought_level', level)
        if (level !== this.settings.effort && (EFFORT_ORDER as string[]).includes(level)) {
          this.settings = { ...this.settings, effort: level as Effort }
          this.ctx.setEffort?.(level as Effort)
        }
      }
    }
    if (all || 'permissionMode' in want) {
      const mode = MODE_OUT[this.settings.permissionMode] ?? 'default'
      await set('mode', mode)
    }
  }

  private notification(method: string, params: Msg): void {
    if (method !== 'session/update' || str(params.sessionId) !== this.sessionId) return
    const u = obj(params.update)
    if (u.sessionUpdate === 'config_option_update') {
      this.options = configOptions(u.configOptions)
      return
    }
    const r = this.translator.update(u)
    if (r.mode) {
      const mode = MODE_IN[r.mode]
      // 完全放行在 agy 那边就是 accept-edits，它报回来时别把我们的改回「自动编辑」
      const same = mode === 'edits' && this.settings.permissionMode === 'full'
      if (mode && !same && mode !== this.settings.permissionMode) {
        this.settings = { ...this.settings, permissionMode: mode }
        this.ctx.setPermissionMode(mode)
      }
    }
    if (r.commands) this.ctx.emit({ type: 'commands', commands: r.commands })
    if (r.context) {
      this.lastContext = r.context
      const model = this.currentModel()
      this.ctx.emit({
        type: 'usage',
        usage: {
          inputTokens: this.totals.input,
          outputTokens: this.totals.output,
          cacheReadTokens: this.totals.cacheRead,
          cacheWriteTokens: this.totals.cacheWrite,
          contextTokens: r.context.used,
          contextWindow: r.context.size || null,
          costUsd: null,
        },
      })
      this.ctx.emit({
        type: 'context',
        context: {
          model,
          used: r.context.used,
          window: r.context.size || null,
          input: null,
          cacheRead: null,
          cacheWrite: null,
          output: null,
          observedAt: Date.now(),
          source: 'request',
          stale: false,
          compacting: false,
          diagnostic: null,
          diagnosticStale: true,
        },
      })
    }
  }

  private currentModel(): string {
    return this.options.find(o => o.id === 'model')?.currentValue || this.settings.model || 'antigravity'
  }

  private permission(params: Msg): Promise<Msg> {
    // 应用自己的只读 MCP（查看别的会话等）不用逐次审批，和 Claude 的 allowTools 一样；agy 的工具名是 mcp_<服务>_<工具>（§12 实测）
    const name = str(obj(params.toolCall).name)
    // 按最长的服务名认归属：扩展包的服务叫 pixelsky_threads_x 时，它的工具不能借应用自己的名字免审批
    const owner = (this.ctx.extensions?.acpMcp ?? [])
      .filter(s => name.startsWith(`mcp_${s.name}_`))
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (owner?.own) {
      const allow = (Array.isArray(params.options) ? params.options : []).map(obj).find(o => o.kind === 'allow_once')
      if (allow) return Promise.resolve({ outcome: { outcome: 'selected', optionId: str(allow.optionId) } })
    }
    const requestId = 'ag-req-' + randomUUID().slice(0, 8)
    const request = this.translator.approval(requestId, params)
    const options = (Array.isArray(params.options) ? params.options : []).map(o => ({
      optionId: str(obj(o).optionId),
      kind: str(obj(o).kind),
    }))
    const keys = approvalKeys(request)
    const allowOnce = options.find(o => o.kind === 'allow_once')
    const full = this.settings.permissionMode === 'full'
    if (allowOnce && (full || (keys.length && keys.every(k => this.allowedForSession.has(k)))))
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: allowOnce.optionId } })
    return new Promise(resolve => {
      this.approvals.set(requestId, { options, keys, resolve: outcome => resolve({ outcome }) })
      this.ctx.emit({ type: 'approval_request', request })
    })
  }

  answer(requestId: string, decision: ApprovalDecision): void {
    const question = this.questions.get(requestId)
    if (question) {
      this.questions.delete(requestId)
      this.ctx.emit({ type: 'approval_resolved', requestId })
      question(decision)
      return
    }
    const pending = this.approvals.get(requestId)
    this.approvals.delete(requestId)
    this.ctx.emit({ type: 'approval_resolved', requestId })
    if (!pending) return
    if (decision.type === 'allow_always') for (const k of pending.keys) this.allowedForSession.add(k)
    const allow = decision.type === 'allow' || decision.type === 'allow_always' || decision.type === 'allow_all'
    const opt =
      pending.options.find(o => o.kind === (allow ? 'allow_once' : 'reject_once')) ??
      pending.options.find(o => o.kind.startsWith(allow ? 'allow' : 'reject'))
    pending.resolve(opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' })
  }

  private cancelApprovals(): void {
    for (const [id, q] of this.questions) {
      q(null)
      this.ctx.emit({ type: 'approval_resolved', requestId: id })
    }
    this.questions.clear()
    for (const [id, p] of this.approvals) {
      p.resolve({ outcome: 'cancelled' })
      this.ctx.emit({ type: 'approval_resolved', requestId: id })
    }
    this.approvals.clear()
  }

  /** 提问卡片：等用户回答 / 跳过（deny）/ 停止（null） */
  private ask(q: AgyQuestion): Promise<ApprovalDecision | null> {
    const requestId = 'ag-ask-' + randomUUID().slice(0, 8)
    return new Promise(resolve => {
      this.questions.set(requestId, resolve)
      this.ctx.emit({
        type: 'approval_request',
        request: {
          requestId,
          itemId: q.itemId,
          kind: 'question',
          title: 'Antigravity 提问',
          questions: q.questions,
          alwaysScopes: [],
          canAllowAll: false,
        },
      })
    })
  }

  send(
    text: string,
    turnId: string,
    _userItemId: string,
    attachments: ImageAttachment[] = [],
    _seed?: unknown,
    handoffImages: ImageAttachment[] = [],
  ): void {
    const active: Active = { id: turnId, started: Date.now(), promptSent: false }
    this.active = active
    void this.run(active, text, [...handoffImages, ...attachments])
  }

  private async run(active: Active, text: string, images: ImageAttachment[]): Promise<void> {
    try {
      await this.open()
      if (this.active !== active || !this.conn || !this.sessionId) return
      // 从这里起 agy 那边有 prompt 在跑（含代发的 /compact）：停止要发 session/cancel，不能只在本地结束
      active.promptSent = true
      // 自动压缩阈值：agy 固定约 256K 才自己压，设了阈值时到了就先发一次 /compact（§12 实测上下文 53.7K → 15.4K，这一步不出文字）
      const pct = this.launch.autoCompactPct
      const c = this.lastContext
      if (pct && c && c.size > 0 && c.used * 100 >= c.size * pct && !text.trimStart().startsWith('/compact')) {
        const compacted = obj(
          await this.conn.request(
            'session/prompt',
            { sessionId: this.sessionId, prompt: [{ type: 'text', text: '/compact' }] },
            TURN_TIMEOUT,
          ),
        )
        this.lastContext = null
        if (this.active !== active || !this.conn || !this.sessionId) return
        // 压缩时点了停止：用户的消息不再发
        if (compacted.stopReason === 'cancelled') {
          this.finish('interrupted', null)
          return
        }
      }
      let prompt: Msg[] = [
        { type: 'text', text },
        ...images.map(i => ({ type: 'image', mimeType: i.mediaType, data: i.dataBase64 })),
      ]
      const usage: Record<string, number> = {}
      let r: Msg = {}
      // agy 提问时这一次 prompt 就结束了：我们把这一轮留着，弹提问卡片，回答当下一次 prompt 发回去（§12）
      for (;;) {
        if (!this.conn || !this.sessionId) throw new Error('Antigravity 进程退出了')
        r = obj(await this.conn.request('session/prompt', { sessionId: this.sessionId, prompt }, TURN_TIMEOUT))
        if (this.active !== active) return
        for (const [k, v] of Object.entries(obj(r.usage))) if (typeof v === 'number') usage[k] = (usage[k] ?? 0) + v
        const question = !this.translator.error && r.stopReason !== 'cancelled' ? this.translator.takeQuestion() : null
        if (!question) break
        const decision = await this.ask(question)
        if (this.active !== active) return
        if (!decision) {
          this.finish('interrupted', null, usage)
          return
        }
        const reply = answerText(question.questions, decision)
        this.translator.resolveQuestion(question.itemId, reply ?? '（没有回答）')
        if (reply === null) break
        prompt = [{ type: 'text', text: reply }]
      }
      const error = this.translator.error
      const outcome: TurnOutcome = error ? 'failed' : r.stopReason === 'cancelled' ? 'interrupted' : 'completed'
      this.finish(
        outcome,
        error
          ? error
              .replace(AGY_ERROR_PREFIX, '')
              .replace(/^[:\s]+/, '')
              .trim()
          : null,
        usage,
      )
    } catch (error) {
      if (this.active === active) this.finish('failed', (error as Error).message)
    }
  }

  private finish(outcome: TurnOutcome, error: string | null, usage?: unknown): void {
    const active = this.active
    if (!active) return
    this.active = null
    this.cancelApprovals()
    this.translator.finish(outcome)
    if (error)
      this.ctx.emit({
        type: 'item_completed',
        item: { kind: 'notice', id: 'ag-error-' + active.id, level: 'error', text: error, detail: null },
      })
    const turnUsage = usage ? agyTurnUsage(usage, this.currentModel(), Date.now() - active.started) : undefined
    if (turnUsage)
      for (const m of Object.values(turnUsage.models)) {
        this.totals.input += m.input
        this.totals.output += m.output
        this.totals.cacheRead += m.cacheRead
        this.totals.cacheWrite += m.cacheWrite
      }
    this.ctx.emit({
      type: 'turn_completed',
      turnId: active.id,
      outcome,
      error,
      ...(turnUsage ? { usage: turnUsage } : {}),
    })
    const waiters = this.turnWaiters
    this.turnWaiters = []
    for (const w of waiters) w()
  }

  private waitTurnEnd(ms: number): Promise<boolean> {
    if (!this.active) return Promise.resolve(true)
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), ms)
      this.turnWaiters.push(() => (clearTimeout(timer), resolve(true)))
    })
  }

  async interrupt(): Promise<void> {
    const active = this.active
    if (!active) return
    if (!active.promptSent || !this.conn || !this.sessionId) {
      this.finish('interrupted', null)
      return
    }
    // 取消会关掉进行中的工具、作废等待的权限请求（§7：约 2 ms 回 cancelled）
    this.cancelApprovals()
    this.conn.notify('session/cancel', { sessionId: this.sessionId })
    if (!(await this.waitTurnEnd(5_000))) {
      await this.dropConnection()
      this.finish('interrupted', null)
    }
  }

  async update(patch: Partial<SessionSettings>, strict = false): Promise<void> {
    this.settings = { ...this.settings, ...patch }
    if (this.opening) await this.opening.catch(() => {})
    try {
      await this.apply(patch)
    } catch (error) {
      if (strict) throw error
    }
  }

  private exited(stderr: string): void {
    this.conn = null
    this.sessionId = null
    if (this.active && !this.closed)
      this.finish('failed', stderr.trim().split(/\r?\n/).slice(-3).join('\n') || 'Antigravity 进程退出了')
  }

  private async dropConnection(): Promise<void> {
    const conn = this.conn
    this.conn = null
    this.sessionId = null
    await conn?.close(500)
  }

  async close(opts: CloseOptions = {}): Promise<void> {
    this.closed = true
    if (this.active) this.finish('interrupted', null)
    const conn = this.conn
    this.conn = null
    this.sessionId = null
    await conn?.close(opts.quick ? 300 : 2000)
  }
}
