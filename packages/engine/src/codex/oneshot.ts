// Codex 单独问一次（AI 写提交信息的 ChatGPT 授权通道，docs/ui/ai-commit-channels.md §4）：起一个临时 app-server，
// 在临时目录里开线程（只读沙箱、从不审批、尽量不留记录），发一条消息，等这一轮结束，取最后一条回复。
// 旁聊（docs/ui/codex-sidechat.md）传 fork：改成从会话的线程临时分叉（带上下文、不落盘），在会话目录里跑
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Launcher } from '../adapter'
import {
  ONE_SHOT_TIMEOUT,
  OneShotError,
  oneShotProblem,
  type OneShotProblem,
  type OneShotReply,
  type OneShotRequest,
} from '../oneshot'
import { CodexProcess, object, string, type Message } from './process'
import { tokenCounts } from './translate'
import { removeTree } from '../exec'

/** Codex 错误里的 codexErrorInfo → 原因；认不出时按原话分类 */
export function codexOneShotProblem(error: unknown): OneShotProblem {
  const e = object(error)
  const info = e.codexErrorInfo
  const kinds = typeof info === 'string' ? [info] : info && typeof info === 'object' ? Object.keys(info) : []
  for (const kind of kinds) {
    if (/usageLimit/i.test(kind)) return 'usageLimit'
    if (/unauthorized/i.test(kind)) return 'notAuthorized'
  }
  if (info && typeof info === 'object')
    for (const value of Object.values(info as Record<string, unknown>))
      if (object(value).httpStatusCode === 401) return 'notAuthorized'
  return oneShotProblem(string(e.message))
}

function removeLater(dir: string): void {
  setTimeout(() => {
    try {
      removeTree(dir, { maxRetries: 3, retryDelay: 200 })
    } catch {
      // 临时目录，删不掉也不影响
    }
  }, 500).unref?.()
}

/** 旁聊的分叉：会话线程、截断点（回退了还没发新消息时是保留的最后一轮）、会话目录、强度、模型来源（和会话进程一样显式带上） */
export interface CodexSideFork {
  threadId: string
  lastTurnId: string | null
  cwd: string
  effort: string | null
  modelProvider: string | null
}

/** 旁聊和 Claude 旁聊一样等 5 分钟（会话强度可能很高）；提交信息这类单次问答仍是 ONE_SHOT_TIMEOUT */
const SIDE_TIMEOUT = 5 * 60_000

export async function codexOneShot(
  launcher: Launcher,
  launchArgs: string[],
  env: NodeJS.ProcessEnv,
  req: OneShotRequest,
  signal: AbortSignal,
  fork?: CodexSideFork,
): Promise<OneShotReply> {
  if (signal.aborted) throw new OneShotError('cancelled', '已停止')
  const home = mkdtempSync(join(tmpdir(), 'pixelsky-codex-oneshot-'))
  let text = ''
  let usage: OneShotReply['usage'] = null
  let lastError: unknown = null
  let finish!: (outcome: { ok: true } | { ok: false; error: OneShotError }) => void
  const ended = new Promise<{ ok: true } | { ok: false; error: OneShotError }>(resolve => (finish = resolve))
  const proc: CodexProcess = new CodexProcess(
    launcher,
    ['app-server', '--listen', 'stdio://', ...launchArgs],
    fork?.cwd ?? home,
    env,
    {
      notification: (method: string, params: Message) => {
        if (method === 'item/completed') {
          const item = object(params.item)
          if (item.type === 'agentMessage' && string(item.text).trim()) text = string(item.text)
        } else if (method === 'thread/tokenUsage/updated') {
          const last = tokenCounts(object(params.tokenUsage).last)
          usage = { input: last.input, output: last.output, cacheRead: last.cacheRead, cacheWrite: last.cacheWrite }
        } else if (method === 'error' && params.willRetry !== true) lastError = params.error
        else if (method === 'turn/completed') {
          const turn = object(params.turn)
          if (turn.status === 'completed') finish({ ok: true })
          else {
            const error = turn.error ?? lastError
            const message =
              string(object(error).message) || (turn.status === 'interrupted' ? '已停止' : 'Codex 没有写成')
            finish({ ok: false, error: new OneShotError(codexOneShotProblem(error), message) })
          }
        }
      },
      // 只读沙箱、从不审批：不该有请求，来了一律拒绝
      request: id => proc.respondError(id, 'Not available in a one-shot request'),
      exit: (_code, tail) => {
        const message = tail.trim().split(/\r?\n/).at(-1) || 'Codex 意外退出'
        finish({ ok: false, error: new OneShotError(oneShotProblem(message), message) })
      },
    },
  )
  const onAbort = (): void => finish({ ok: false, error: new OneShotError('cancelled', '已停止') })
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(
    () => finish({ ok: false, error: new OneShotError('timeout', 'Codex 太久没有回答') }),
    fork ? SIDE_TIMEOUT : ONE_SHOT_TIMEOUT,
  )
  try {
    const run = (async () => {
      await proc.initialize(true)
      const params = {
        cwd: fork?.cwd ?? home,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ...(req.model ? { model: req.model } : {}),
      }
      // 临时分叉必须 excludeTurns（0.166 起），不然报错；分叉做不到就不问，不留一份记录在用户的 Codex 历史里
      // 不留记录（ephemeral）：旧版 Codex 不认这个字段时不带它再开一次
      const thread = fork
        ? await proc.request('thread/fork', {
            ...params,
            threadId: fork.threadId,
            ...(fork.lastTurnId ? { lastTurnId: fork.lastTurnId } : {}),
            ...(fork.modelProvider ? { modelProvider: fork.modelProvider } : {}),
            ephemeral: true,
            excludeTurns: true,
          })
        : await proc.request('thread/start', { ...params, ephemeral: true }).catch((error: Error) => {
            if (/ephemeral|unknown field|invalid params/i.test(error.message))
              return proc.request('thread/start', params)
            throw error
          })
      const threadId = string(object(thread.thread).id)
      if (!threadId) throw new Error('Codex 没有开出线程')
      const model = string(thread.model) || req.model
      // 线程记着协作模式：会话在计划模式时分叉出来仍按计划的说明走，旁聊这一轮显式切回默认
      const mode =
        fork && model
          ? {
              collaborationMode: {
                mode: 'default',
                settings: { model, reasoning_effort: fork.effort, developer_instructions: null },
              },
            }
          : {}
      await proc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: req.prompt }],
        ...(fork?.effort ? { effort: fork.effort } : {}),
        ...mode,
      })
      return string(thread.model) || null
    })()
    const stopped = ended.then(outcome => {
      if (!outcome.ok) throw outcome.error
      return null
    })
    // 输掉比赛的那一个之后再失败（进程被结束、请求被拒）不能变成没人接的拒绝
    run.catch(() => undefined)
    stopped.catch(() => undefined)
    // 启动 / 开线程失败也算结束
    const model = await Promise.race([run, stopped]).catch((error: unknown) => {
      if (error instanceof OneShotError) throw error
      const message = (error as Error)?.message ?? String(error)
      throw new OneShotError(oneShotProblem(message), message)
    })
    const outcome = await ended
    if (!outcome.ok) throw outcome.error
    return { text, model, usage }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    proc.kill()
    removeLater(home)
  }
}
