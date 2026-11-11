// 目标状态保存在 Pi 会话分支中；每轮真正 settled 后才续轮，让重试、压缩、审批和用户插话照常工作。
import { randomUUID } from 'node:crypto'
import type { ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { GOAL_TEXT, parseGoalCommand, type GoalStatus, type SessionGoal } from '../../../protocol/src/types/goal.ts'
import {
  PIXEL_GOAL_COMMAND,
  PIXEL_GOAL_CONTEXT,
  PIXEL_GOAL_CONTINUE,
  PIXEL_GOAL_ENTRY,
  PIXEL_GOAL_STATUS,
  pixelGoalReport,
  type PixelGoalAction,
} from '../../../protocol/src/pixel-goal.ts'
import { httpStatusOf, noticeErrorOf } from '../../../protocol/src/notices.ts'
import { SUBAGENT_TOOL, usageTokens } from '../tools/subagent.ts'
import { LOOP_GUARD_RESET_EVENT, LOOP_GUARD_STOP_EVENT } from './loopGuard.ts'

const CONTINUE_DELAY_MS = 100
type SavedGoal = { id: string; goal: SessionGoal | null; held: boolean }

export const goalExtension: ExtensionFactory = pi => {
  let goal: SessionGoal | null = null
  let id = ''
  let held = false
  let ctx: ExtensionContext | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let clockAt: number | null = null
  let requestGoal = ''
  let compactGoal = ''
  let lastError: string | null = null
  let run = 0
  let blocker: { reason: string; count: number; run: number } | null = null
  const agentUsage = new Map<string, { goalId: string; tokens: number }>()

  const cancel = (): void => {
    clearTimeout(timer)
    timer = undefined
  }
  const accountTime = (): void => {
    if (goal && clockAt !== null) {
      const now = Date.now()
      goal = { ...goal, timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, now - clockAt) / 1000 }
      clockAt = now
    }
  }
  const report = (req?: string, error?: string): void => {
    accountTime()
    ctx?.ui.setStatus(PIXEL_GOAL_STATUS, JSON.stringify({ version: 1, goal, req, error }))
  }
  const save = (): void => {
    accountTime()
    if (goal) goal = { ...goal, updatedAt: Date.now() }
    pi.appendEntry<SavedGoal>(PIXEL_GOAL_ENTRY, { id, goal, held })
    report()
  }
  const status = (next: GoalStatus, announce = false): void => {
    if (!goal || goal.status === next) return
    goal = { ...goal, status: next }
    if (next !== 'active') cancel()
    save()
    if (!announce) return
    const text =
      next === 'complete'
        ? GOAL_TEXT.goalComplete(goal.objective)
        : next === 'blocked'
          ? GOAL_TEXT.goalBlocked(goal.objective, '像素星空')
          : next === 'budgetLimited'
            ? GOAL_TEXT.goalBudgetLimited
            : next === 'usageLimited'
              ? GOAL_TEXT.goalUsageLimited
              : null
    if (text) ctx?.ui.notify(text, next === 'complete' ? 'info' : 'warning')
  }
  const exhausted = (): boolean => !!goal && goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget
  const addTokens = (tokens: number, owner = id): void => {
    if (!goal || owner !== id || !Number.isFinite(tokens) || tokens <= 0) return
    goal = { ...goal, tokensUsed: goal.tokensUsed + tokens }
    if (exhausted() && goal.status !== 'complete') {
      status('budgetLimited', true)
      // 已经发出的请求计完再停，不能再发下一次请求或绕过预算继续调用工具。
      ctx?.abort()
    } else save()
  }
  const schedule = (): void => {
    cancel()
    if (goal?.status !== 'active' || !ctx || running) return
    const owner = id
    timer = setTimeout(() => {
      timer = undefined
      if (id !== owner || goal?.status !== 'active' || !ctx?.isIdle() || ctx.hasPendingMessages()) return
      if (exhausted()) return status('budgetLimited', true)
      pi.sendMessage(
        {
          customType: PIXEL_GOAL_CONTINUE,
          content: 'Continue working toward the current goal. Use get_goal to check its latest state.',
          display: false,
        },
        { triggerTurn: true },
      )
    }, CONTINUE_DELAY_MS)
  }
  const apply = (action: PixelGoalAction): void => {
    if (action.kind === 'get') return
    if (action.kind === 'set') {
      const objective = action.objective?.trim()
      const budget = action.tokenBudget ?? null
      if (!objective || objective.length > 4000) throw new Error('目标文字须为 1–4000 字')
      if (budget !== null && (!Number.isSafeInteger(budget) || budget <= 0)) throw new Error('token 预算必须是正整数')
      cancel()
      id = randomUUID()
      held = false
      blocker = null
      pi.events.emit(LOOP_GUARD_RESET_EVENT, {})
      goal = {
        objective,
        status: 'active',
        tokensUsed: 0,
        tokenBudget: budget,
        timeUsedSeconds: 0,
        updatedAt: Date.now(),
      }
      clockAt = running ? Date.now() : null
      save()
      schedule()
      return
    }
    if (action.kind === 'clear') {
      cancel()
      goal = null
      id = ''
      held = false
      clockAt = null
      blocker = null
      save()
      return
    }
    if (!goal) {
      if (action.kind === 'hold') return
      throw new Error(GOAL_TEXT.goalNone)
    }
    if (action.kind === 'hold') {
      if (goal.status !== 'active') return
      held = true
      status('paused')
    } else if (action.kind === 'pause') {
      held = false
      cancel()
      status('paused')
      save()
    } else if (action.kind === 'resume') {
      if (exhausted()) throw new Error(GOAL_TEXT.goalBudgetResume)
      if (goal.status === 'complete') throw new Error('目标已完成，请设置新目标')
      held = false
      blocker = null
      pi.events.emit(LOOP_GUARD_RESET_EVENT, {})
      status('active')
      if (running && clockAt === null) clockAt = Date.now()
      schedule()
    } else throw new Error('目标操作不对')
  }
  const result = () => {
    accountTime()
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ goal_id: id || null, goal, blocker }) }],
      details: { goal },
    }
  }

  pi.on('session_start', (_event, context) => {
    cancel()
    ctx = context
    running = false
    clockAt = null
    requestGoal = ''
    lastError = null
    blocker = null
    agentUsage.clear()
    const entry = context.sessionManager
      .getBranch()
      .findLast(e => e.type === 'custom' && e.customType === PIXEL_GOAL_ENTRY)
    const saved = entry?.type === 'custom' ? (entry.data as SavedGoal | undefined) : undefined
    const valid = pixelGoalReport({ version: 1, goal: saved?.goal })
    goal = valid?.goal ?? null
    id = goal ? (typeof saved?.id === 'string' && saved.id ? saved.id : randomUUID()) : ''
    held = !!saved?.held
    // 打开/恢复记录不自动花费；下次普通消息才解除进程退出造成的暂停。用户自己暂停的不解除。
    if (goal?.status === 'active') {
      held = true
      status('paused')
    } else report()
  })
  pi.on('before_agent_start', (event, context) => {
    cancel()
    ctx = context
    running = true
    run++
    lastError = null
    if (event.messageType === 'user') {
      blocker = null
      if (held && goal?.status === 'paused') {
        held = false
        status('active')
      }
    }
    clockAt = goal?.status === 'active' ? Date.now() : null
  })
  pi.on('context', event => {
    // message_start 要等服务端返回首字节才来；在发请求前固定归属，避免中途换目标后把旧请求记到新预算。
    requestGoal = clockAt !== null ? id : ''
    const messages = event.messages.filter(m => m.role !== 'custom' || m.customType !== PIXEL_GOAL_CONTEXT)
    if (!goal) return { messages }
    // 每次请求都用最新目标；中途改目标、清除或暂停时不让旧的说明继续支配模型。
    return {
      messages: [
        ...messages,
        {
          role: 'custom' as const,
          customType: PIXEL_GOAL_CONTEXT,
          display: false,
          timestamp: Date.now(),
          content:
            `[GOAL MODE]\n${JSON.stringify({ goal_id: id, ...goal, blocker })}\n` +
            'Keep working while the goal is active. New user messages steer the work; preserve the goal unless the user changes it. ' +
            'Use get_goal to inspect it. Only call update_goal with complete when the objective is fully achieved and verified; a finished plan or partial result is not completion. ' +
            'Call update_goal with blocked only for the same blocker in three consecutive goal runs when progress requires user input or an external change; reuse the same reason when it recurs. ' +
            'Use paused only when the user explicitly asks to pause. Never resume or change the budget yourself. ' +
            'Pass the goal_id shown here to update_goal so an older run cannot finish a replacement goal. ' +
            'When the goal is paused, blocked, limited or complete, follow the current user message without restarting goal work. ' +
            'Goal mode does not change tool permissions or plan mode. Report the outcome and token usage when finishing.',
        },
      ],
    }
  })
  pi.on('message_start', event => {
    if (event.message.role === 'user') blocker = null
  })
  pi.on('message_end', event => {
    if (event.message.role !== 'assistant') return
    lastError = event.message.stopReason === 'error' ? event.message.errorMessage || 'Model request failed' : null
    addTokens(usageTokens(event.message.usage), requestGoal)
  })
  pi.on('tool_execution_start', event => {
    if (event.toolName === SUBAGENT_TOOL)
      agentUsage.set(event.toolCallId, { goalId: clockAt !== null ? id : '', tokens: 0 })
  })
  const countAgent = (toolCallId: string, result: unknown): void => {
    const previous = agentUsage.get(toolCallId)
    const tokens = (result as { details?: { tokens?: number } } | undefined)?.details?.tokens
    if (!previous || typeof tokens !== 'number' || !Number.isFinite(tokens)) return
    const delta = Math.max(0, tokens - previous.tokens)
    previous.tokens = Math.max(previous.tokens, tokens)
    addTokens(delta, previous.goalId)
  }
  pi.on('tool_execution_update', event => countAgent(event.toolCallId, event.partialResult))
  pi.on('tool_execution_end', event => {
    countAgent(event.toolCallId, event.result)
    agentUsage.delete(event.toolCallId)
  })
  pi.on('session_before_compact', () => {
    compactGoal = clockAt !== null ? id : ''
  })
  pi.on('session_compact', event => addTokens(usageTokens(event.compactionEntry.usage), compactGoal))
  pi.on('agent_settled', event => {
    accountTime()
    clockAt = null
    running = false
    if (goal?.status === 'active') {
      if (event.aborted) {
        held = false
        status('paused')
      } else if (lastError) {
        const kind = noticeErrorOf({ text: lastError, status: httpStatusOf(lastError) })?.kind
        status(kind === 'balance' || kind === 'busy' ? 'usageLimited' : 'blocked', true)
      }
    }
    if (goal) save()
    schedule()
  })
  const offStop = pi.events.on(LOOP_GUARD_STOP_EVENT, () => {
    if (goal?.status === 'active') status('blocked', true)
  })
  pi.on('session_shutdown', () => {
    offStop()
    cancel()
    apply({ kind: 'hold' })
    accountTime()
    clockAt = null
    running = false
  })

  pi.registerCommand('goal', {
    description: 'Set a goal Pixel keeps working toward (/goal pause · resume · clear)',
    handler: async (args, context) => {
      ctx = context
      const action = parseGoalCommand(`/goal ${args}`)!
      try {
        apply(action)
        const text =
          action.kind === 'set'
            ? GOAL_TEXT.goalSet(action.objective, '像素星空')
            : action.kind === 'pause'
              ? GOAL_TEXT.goalPaused
              : action.kind === 'resume'
                ? GOAL_TEXT.goalResumed
                : action.kind === 'clear'
                  ? GOAL_TEXT.goalCleared
                  : goal
                    ? GOAL_TEXT.goalShow(goal.objective, GOAL_TEXT.goalStatus[goal.status])
                    : GOAL_TEXT.goalNone
        context.ui.notify(text, 'info')
      } catch (error) {
        context.ui.notify((error as Error).message, 'warning')
      }
    },
  })
  pi.registerCommand(PIXEL_GOAL_COMMAND, {
    description: 'Pixel desktop goal control',
    handler: async (args, context) => {
      ctx = context
      let req: string | undefined
      try {
        const value = JSON.parse(args) as PixelGoalAction & { req?: string }
        req = typeof value.req === 'string' ? value.req : undefined
        apply(value)
        report(req)
      } catch (error) {
        report(req, (error as Error).message)
      }
    },
  })
  pi.registerTool({
    name: 'create_goal',
    label: 'Create goal',
    description:
      'Create a persistent goal ONLY when the user explicitly requests goal mode. Do not infer goals from ordinary tasks. Fails if an unfinished goal exists. Set token_budget only when the user explicitly specifies one.',
    parameters: Type.Object({
      objective: Type.String({ minLength: 1, maxLength: 4000 }),
      token_budget: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    executionMode: 'sequential',
    async execute(_callId, params) {
      if (goal && goal.status !== 'complete')
        throw new Error('An unfinished goal already exists; use get_goal or update_goal.')
      apply({ kind: 'set', objective: params.objective, tokenBudget: params.token_budget })
      return result()
    },
  })
  pi.registerTool({
    name: 'get_goal',
    label: 'Get goal',
    description:
      'Read the current goal, its goal_id, status, token usage, budget, elapsed work time and blocking audit.',
    parameters: Type.Object({}),
    executionMode: 'sequential',
    async execute() {
      return result()
    },
  })
  pi.registerTool({
    name: 'update_goal',
    label: 'Update goal',
    description:
      'Update the goal with its current goal_id. Complete only when all requested work is achieved and verified. Pause only on an explicit user request. Blocked requires the same reason in three consecutive goal runs and inability to progress without user input or external changes. Cannot resume or change budgets.',
    parameters: Type.Object({
      goal_id: Type.String(),
      status: Type.Union([Type.Literal('complete'), Type.Literal('paused'), Type.Literal('blocked')]),
      reason: Type.Optional(Type.String({ minLength: 1 })),
    }),
    executionMode: 'sequential',
    async execute(_callId, params) {
      if (!goal || params.goal_id !== id)
        throw new Error('The goal changed or was cleared. Call get_goal before updating it.')
      if (exhausted()) throw new Error(GOAL_TEXT.goalBudgetResume)
      if (params.status === 'blocked') {
        const reason = params.reason?.trim()
        if (!reason) throw new Error('Explain the blocker in reason; reuse the same reason if it recurs.')
        if (blocker?.run !== run) {
          blocker = {
            reason,
            run,
            count: blocker?.reason === reason && blocker.run === run - 1 ? blocker.count + 1 : 1,
          }
        }
        if (blocker.count < 3) return result()
      }
      held = false
      status(params.status, true)
      return result()
    },
  })
}
