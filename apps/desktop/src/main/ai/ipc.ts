// AI 写提交信息的 IPC（docs/ui/ai-commit-codex-warnings-history.md §2.5）。在本机主进程执行：账号令牌和自定义接口的 Key
// 只在这里；要提交的改动按项目所在机器取（SSH 项目转发到那台机器）。云端请求照常记下计费 ID，之后按它查实际扣费；
// Claude / ChatGPT 授权用本机引擎单独问一次（docs/ui/ai-commit-channels.md §4）
import { OneShotError } from '@pixelsky/engine'
import { randomUUID } from 'node:crypto'
import type { PlatformCharge, PlatformSettlement } from '@pixelsky/protocol'
import {
  INLINE_EDIT_CONTEXT_LINES,
  INLINE_EDIT_INSTRUCTION_LIMIT,
  INLINE_EDIT_MAX_CHARS,
  INLINE_EDIT_MAX_LINES,
  PROMPT_CONTEXT_LIMIT,
  PROMPT_TEXT_LIMIT,
  type AiChannelRequest,
  type AiCommitRequest,
  type AiCommitResult,
  type AiInlineEditRequest,
  type AiPromptRequest,
} from '../../shared/types/ai'
import type { GitCommitContext } from '../../shared/types/project-tools'
import type { AppContext } from '../app/context'
import { platformFetch, signedInEmail } from '../account/account'
import { writeCommitMessage, type ModelDeps } from '../core/ai/commit-message'
import { inlineEdit } from '../core/ai/inline-edit'
import { optimizePrompt } from '../core/ai/prompt-optimize'
import { workspaceRef } from '../core/workspace-files'
import * as ipc from '../ipc/guard'
import { platformCharges } from '../platform/billing'

const ID = /^[A-Za-z0-9_-]{1,64}$/
/** 查实际扣费：Sub2api 记账有延迟，隔一会儿再查 */
const CHARGE_WAITS = [800, 1500, 3000, 5000]
const KEEP_CHARGES = 20

function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error('参数不正确')
  return value as T
}

/** 通道那几项：逐项检查，不信任 */
function aiChannelRequest(v: Record<string, unknown>): AiChannelRequest {
  if (typeof v.requestId !== 'string' || !ID.test(v.requestId)) throw new Error('参数不正确')
  const groups = v.groups
  if (!Array.isArray(groups) || groups.length > 3 || !groups.every(g => typeof g === 'string' && /^\d{1,20}$/.test(g)))
    throw new Error('参数不正确')
  if (v.providerId !== null && (typeof v.providerId !== 'string' || !ID.test(v.providerId)))
    throw new Error('参数不正确')
  const source = oneOf(v.source, ['platform', 'claude', 'codex', 'custom'])
  // Claude / ChatGPT 授权的模型可以留空：跟随引擎自己的设置
  const engine = source === 'claude' || source === 'codex'
  if (typeof v.model !== 'string' || (!engine && !v.model.trim()) || v.model.length > 200) throw new Error('参数不正确')
  return { requestId: v.requestId, source, groups: groups as string[], providerId: v.providerId, model: v.model.trim() }
}

/** 渲染层传来的请求：逐项检查，不信任 */
export function aiCommitRequest(input: unknown): AiCommitRequest {
  const v = (input ?? {}) as Record<string, unknown>
  const channel = aiChannelRequest(v)
  if (typeof v.instructions !== 'string' || v.instructions.length > 1000) throw new Error('参数不正确')
  return {
    ...channel,
    ref: workspaceRef(v.ref),
    scope: oneOf(v.scope, ['staged', 'all']),
    language: oneOf(v.language, ['auto', 'zh', 'en']),
    uiLanguage: oneOf(v.uiLanguage, ['zh', 'en']),
    style: oneOf(v.style, ['subject', 'body']),
    instructions: v.instructions,
  }
}

export function aiPromptRequest(input: unknown): AiPromptRequest {
  const v = (input ?? {}) as Record<string, unknown>
  const channel = aiChannelRequest(v)
  if (typeof v.text !== 'string' || !v.text.trim() || v.text.length > PROMPT_TEXT_LIMIT) throw new Error('参数不正确')
  if (typeof v.context !== 'string' || v.context.length > PROMPT_CONTEXT_LIMIT) throw new Error('参数不正确')
  return { ...channel, text: v.text, context: v.context }
}

const lineCount = (s: string): number => s.split('\n').length

/** 行内改写：选区最多 INLINE_EDIT_MAX_LINES 行 / INLINE_EDIT_MAX_CHARS 字，前后文各最多 INLINE_EDIT_CONTEXT_LINES 行 */
export function aiInlineEditRequest(input: unknown): AiInlineEditRequest {
  const v = (input ?? {}) as Record<string, unknown>
  const channel = aiChannelRequest(v)
  const text = (x: unknown, max: number, lines: number): string => {
    if (typeof x !== 'string' || x.length > max || lineCount(x) > lines) throw new Error('参数不正确')
    return x
  }
  const instruction = text(v.instruction, INLINE_EDIT_INSTRUCTION_LIMIT, Infinity)
  if (!instruction.trim()) throw new Error('参数不正确')
  return {
    ...channel,
    path: text(v.path, 1000, 1),
    language: text(v.language, 100, 1),
    before: text(v.before, INLINE_EDIT_MAX_CHARS, INLINE_EDIT_CONTEXT_LINES),
    code: text(v.code, INLINE_EDIT_MAX_CHARS, INLINE_EDIT_MAX_LINES),
    after: text(v.after, INLINE_EDIT_MAX_CHARS, INLINE_EDIT_CONTEXT_LINES),
    instruction,
  }
}

export function initAi(ctx: AppContext): void {
  const running = new Map<string, AbortController>()
  /** 渲染层的 requestId → 这次云端请求的结算信息 */
  const settlements = new Map<string, PlatformSettlement>()

  const context = (ref: AiCommitRequest['ref'], scope: AiCommitRequest['scope']): Promise<GitCommitContext> => {
    const channel = 'projectTools:gitCommitContext'
    const local = ctx.toolOps.get(channel)
    if (!local) throw new Error('项目尚未加载')
    const args = [ref, { scope }]
    return Promise.resolve(
      ctx.machines ? ctx.machines.invoke(channel, args, () => local(args)) : local(args),
    ) as Promise<GitCommitContext>
  }

  /** 问一次模型：可以按 requestId 停止；云端请求记下计费 ID，之后 ai:commitCharge 按它查实际扣费 */
  const run = async (
    req: AiChannelRequest,
    task: (deps: ModelDeps, signal: AbortSignal) => Promise<AiCommitResult & { chargeId?: string }>,
  ): Promise<AiCommitResult> => {
    running.get(req.requestId)?.abort()
    const abort = new AbortController()
    running.set(req.requestId, abort)
    const account = signedInEmail()
    const startedAt = Date.now()
    let sent: { id: string; groupId: string } | null = null
    try {
      const outcome = await task(
        {
          platform: (body, groupId, signal) => {
            sent = { id: `pixelsky-${randomUUID()}`, groupId }
            return platformFetch('/v1/platform/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'anthropic-version': '2023-06-01',
                'X-PixelSky-Group': groupId,
                'X-Client-Request-ID': sent.id,
              },
              body,
              signal,
            })
          },
          provider: id => ctx.providers?.resolve(id) ?? null,
          fetch: (url, init) => fetch(url, init),
          engine: (engine, request, signal) =>
            ctx.engine
              ? ctx.engine.oneShot(engine, request, signal)
              : Promise.reject(new OneShotError('failed', '引擎还没准备好')),
        },
        abort.signal,
      )
      if (!outcome.ok) return outcome
      const { chargeId, ...result } = outcome
      const request = sent as { id: string; groupId: string } | null
      if (result.chargeable && account && request) {
        settlements.set(req.requestId, {
          account,
          requests: [
            {
              id: request.id,
              ...(chargeId && chargeId !== request.id ? { chargeId } : {}),
              model: req.model,
              groupId: request.groupId,
            },
          ],
          startedAt,
          complete: true,
        })
        while (settlements.size > KEEP_CHARGES) settlements.delete(settlements.keys().next().value!)
      }
      return { ...result, chargeable: settlements.has(req.requestId) }
    } finally {
      if (running.get(req.requestId) === abort) running.delete(req.requestId)
    }
  }

  ipc.handle('ai:commitMessage', (_e, input: unknown) => {
    const req = aiCommitRequest(input)
    return run(req, (deps, signal) => writeCommitMessage({ ...deps, context }, req, signal))
  })

  ipc.handle('ai:optimizePrompt', (_e, input: unknown) => {
    const req = aiPromptRequest(input)
    return run(req, (deps, signal) => optimizePrompt(deps, req, signal))
  })

  ipc.handle('ai:inlineEdit', (_e, input: unknown) => {
    const req = aiInlineEditRequest(input)
    return run(req, (deps, signal) => inlineEdit(deps, req, signal))
  })

  ipc.handle('ai:cancel', (_e, id: unknown) => {
    if (typeof id === 'string') running.get(id)?.abort()
  })

  // 实际扣了多少（美元）；Sub2api 还没记上、查不到时为 null
  ipc.handle('ai:commitCharge', async (_e, id: unknown): Promise<number | null> => {
    const settlement = typeof id === 'string' ? settlements.get(id) : undefined
    if (!settlement) return null
    const wanted = new Set(settlement.requests.map(r => r.chargeId ?? r.id))
    for (const wait of CHARGE_WAITS) {
      await new Promise(r => setTimeout(r, wait))
      let charges: PlatformCharge[]
      try {
        charges = await platformCharges(settlement, AbortSignal.timeout(20_000))
      } catch {
        return null
      }
      const mine = charges.filter(c => wanted.has(c.requestId))
      if (mine.length) return mine.reduce((sum, c) => sum + c.costUsd, 0)
    }
    return null
  })
}
