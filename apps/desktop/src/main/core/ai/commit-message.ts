// AI 写提交信息（docs/ui/ai-commit-codex-warnings-history.md §2）：取改动 → 拼提示 → 调一次模型 → 清理返回。
// 云端走 /v1/platform/messages（带线路，Sub2api 照常按线路倍率扣费），线路拒绝时换下一条；
// 自定义 API 用已有的接口配置；Claude / ChatGPT 授权在本机单独问一次引擎（docs/ui/ai-commit-channels.md §4），用订阅额度、不扣余额。
// 出错都换成 AiProblem，界面按它给说法和按钮
import type { OneShotReply, OneShotRequest } from '@pixelsky/engine'
import type { AiChannelRequest, AiCommitRequest, AiCommitResult, AiProblem, AiUsage } from '../../../shared/types/ai'
import type { GitCommitContext, GitContextFile } from '../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../shared/types/workspace'
import type { ResolvedProvider } from '../providers/store'
import {
  classifyError,
  classifyStatus,
  providerHeaders,
  redact,
  upstreamUrl,
  type Fetch,
  PROTOCOL_PATH,
} from '../providers/upstream'
import { oneShotBody, parseReply, type OneShotProtocol } from './oneshot'

/** 提交信息的上限（和 git 提交那边一致） */
export const MESSAGE_LIMIT = 20_000
const MAX_TOKENS = 1024
export const TIMEOUT = 90_000
const DETAIL_LIMIT = 300

/** 四条通道怎么发（AI 写提交信息、优化提示词共用） */
export interface ModelDeps {
  /** 云端：POST /v1/platform/messages；没登录时抛错（code AUTH_EXPIRED 或「请先登录」） */
  platform(body: string, groupId: string, signal: AbortSignal): Promise<Response>
  provider(id: string): ResolvedProvider | null
  fetch: Fetch
  /** Claude / ChatGPT 授权：本机引擎单独问一次；出错抛带 kind 的错误（OneShotError） */
  engine(engine: 'claude' | 'codex' | 'antigravity', req: OneShotRequest, signal: AbortSignal): Promise<OneShotReply>
}

export interface CommitMessageDeps extends ModelDeps {
  /** 在项目所在的机器上取改动（SSH 自动转发） */
  context(ref: WorkspaceRef, scope: AiCommitRequest['scope']): Promise<GitCommitContext>
}

/** 成功时还带上计费用的 ID（云端回传的 X-Client-Request-ID） */
export type CommitMessageOutcome = AiCommitResult & { chargeId?: string }

const NOTE: Record<GitContextFile['content'], string> = {
  diff: '',
  cut: ' [diff truncated]',
  listed: ' [lock or generated file, content not included]',
  secret: ' [may contain secrets, content withheld]',
  binary: ' [binary]',
  omitted: ' [diff not included: size limit]',
}

function fileLine(f: GitContextFile): string {
  const name = f.origPath ? `${f.origPath} → ${f.path}` : f.path
  const stat = f.insertions === null ? '' : ` (+${f.insertions} -${f.deletions ?? 0})`
  return `${f.code} ${name}${stat}${NOTE[f.content]}`
}

/** 系统提示和用户消息（§2.2） */
export function commitPrompt(
  c: GitCommitContext,
  o: Pick<AiCommitRequest, 'language' | 'uiLanguage' | 'style' | 'instructions'>,
): { system: string; prompt: string } {
  const named = (l: 'zh' | 'en') => (l === 'zh' ? 'Simplified Chinese' : 'English')
  const language =
    o.language === 'auto'
      ? `Match the language of the recent commit subjects; if there are none, write in ${named(o.uiLanguage)}.`
      : `Write in ${named(o.language)}.`
  const style =
    o.style === 'subject'
      ? 'Write only the subject line.'
      : 'For a small change write only the subject line. If the change is larger, add a blank line and a short body (a few lines or "- " bullet points) saying what changed and why.'
  const system = [
    'You write git commit messages.',
    'Output only the commit message itself: no code fences, no surrounding quotes, no explanations, no preamble.',
    'The first line is a concise subject, ideally at most 72 characters, without a trailing period.',
    style,
    language,
    'Follow the conventions of the recent commit subjects (for example prefixes like "feat:" / "fix:", capitalization, length).',
    'Describe only what the diff shows; do not invent changes. Some files are listed without content (lock files, secrets, binaries, or over the size limit).',
    ...(o.instructions.trim() ? ['', 'Additional instructions from the user:', o.instructions.trim()] : []),
  ].join('\n')
  const prompt = [
    `Branch: ${c.branch ?? '(detached HEAD)'}`,
    '',
    c.recent.length ? 'Recent commit subjects (newest first):' : 'This repository has no commits yet.',
    ...c.recent.map(s => `- ${s}`),
    '',
    `Files to commit (${c.files.length}${c.truncated ? '+, list truncated' : ''}):`,
    ...c.files.map(fileLine),
    '',
    c.patch ? 'Diff:' : 'No diff content is included.',
    c.patch,
  ].join('\n')
  return { system, prompt }
}

/** 去掉首尾空白、外层代码块和引号、「提交信息：」之类的开头；最多 MESSAGE_LIMIT 字 */
export function cleanMessage(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text)
  if (fenced) text = fenced[1].trim()
  text = text.replace(/^(commit message|提交信息|提交说明)\s*[:：]\s*/i, '').trim()
  const quoted = /^(["'“「`])([\s\S]*)(["'”」`])$/.exec(text)
  if (quoted && !quoted[2].includes(quoted[1])) text = quoted[2].trim()
  return text
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, MESSAGE_LIMIT)
    .trim()
}

const cut = (s: string): string => (s.length > DETAIL_LIMIT ? s.slice(0, DETAIL_LIMIT) + '…' : s)

function upstreamText(body: string): string {
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    if (typeof json.error === 'string') return json.error
    if (json.error && typeof json.error.message === 'string') return json.error.message
    if (typeof json.message === 'string') return json.message
  } catch {
    /* 不是 JSON */
  }
  return body.trim()
}

/** 云端返回的错误 → 原因；route 时换下一条线路再试 */
export function platformProblem(status: number, body: string): { problem: AiProblem; detail: string } {
  const detail = cut(upstreamText(body))
  if (status === 401) return { problem: 'signedOut', detail }
  if (status === 402 || /insufficient|balance|余额|额度不足|quota/i.test(detail)) return { problem: 'balance', detail }
  if (status === 403) return { problem: 'route', detail }
  if ((status === 400 || status === 404) && /model|模型/i.test(detail)) return { problem: 'model', detail }
  if (status === 429) return { problem: 'rateLimit', detail }
  return { problem: 'failed', detail: detail || `HTTP ${status}` }
}

/** 发请求时抛出的错误；cancel 是用户的停止（超时另算） */
function thrown(error: unknown, cancel: AbortSignal): { problem: AiProblem; detail: string } {
  const e = error as { name?: string; code?: unknown; message?: string }
  if (cancel.aborted) return { problem: 'cancelled', detail: '' }
  if (e?.code === 'AUTH_EXPIRED' || /请先登录/.test(e?.message ?? '')) return { problem: 'signedOut', detail: '' }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { problem: 'timeout', detail: '' }
  return { problem: 'network', detail: cut(e?.message ?? String(error)) }
}

const fail = (problem: AiProblem, detail = ''): CommitMessageOutcome => ({ ok: false, problem, detail })

const ENGINE_PROBLEMS = new Set<AiProblem>([
  'notInstalled',
  'notAuthorized',
  'usageLimit',
  'model',
  'timeout',
  'cancelled',
  'failed',
])

/** 引擎单独问一次时抛出的错误 → 原因（OneShotError 的 kind 和 AiProblem 同名） */
function engineProblem(error: unknown, cancel: AbortSignal): { problem: AiProblem; detail: string } {
  if (cancel.aborted) return { problem: 'cancelled', detail: '' }
  const e = error as { kind?: unknown; message?: string }
  const problem =
    typeof e?.kind === 'string' && ENGINE_PROBLEMS.has(e.kind as AiProblem) ? (e.kind as AiProblem) : 'failed'
  // 不是用户停的：是这边的总超时把引擎停了
  if (problem === 'cancelled') return { problem: 'timeout', detail: '' }
  return { problem, detail: cut(e?.message ?? String(error)) }
}

export async function writeCommitMessage(
  deps: CommitMessageDeps,
  req: AiCommitRequest,
  cancel: AbortSignal,
): Promise<CommitMessageOutcome> {
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(TIMEOUT)])
  let context: GitCommitContext
  try {
    context = await deps.context(req.ref, req.scope)
  } catch (error) {
    return cancel.aborted ? fail('cancelled') : fail('failed', cut((error as Error).message ?? String(error)))
  }
  if (!context.files.length) return fail('nothing')
  if (cancel.aborted) return fail('cancelled')
  const { system, prompt } = commitPrompt(context, req)
  const partial = context.files.filter(f => f.content === 'cut' || f.content === 'omitted').length
  const asked = await askModel(deps, req, { system, prompt, maxTokens: MAX_TOKENS }, cancel, signal)
  if (!asked.ok) return asked
  const { text, truncated: _cut, ...rest } = asked
  const message = cleanMessage(text)
  if (!message) return fail('empty')
  return { ...rest, message, partial }
}

/** 模型回的原文；成功时的其它字段和 AiCommitResult 一样（partial 由调用方填） */
export type Asked =
  | {
      ok: true
      text: string
      /** 写到输出上限被截断；引擎（Claude / ChatGPT 授权）不报，总是 false */
      truncated: boolean
      model: string
      groupId: string | null
      usage: AiUsage | null
      chargeable: boolean
      chargeId?: string
    }
  | { ok: false; problem: AiProblem; detail: string }

/** 按 req 的通道问一次模型。cancel 是用户的停止，signal 另带总超时 */
export async function askModel(
  deps: ModelDeps,
  req: AiChannelRequest,
  ask: { system: string; prompt: string; maxTokens: number },
  cancel: AbortSignal,
  signal: AbortSignal,
): Promise<Asked> {
  const { system, prompt, maxTokens } = ask
  const failed = (problem: AiProblem, detail = ''): Asked => ({ ok: false, problem, detail })

  const finish = async (res: Response, protocol: OneShotProtocol, groupId: string | null): Promise<Asked> => {
    let body: unknown
    try {
      body = await res.json()
    } catch (error) {
      const t = thrown(error, cancel)
      return failed(t.problem === 'network' ? 'failed' : t.problem, t.detail)
    }
    const reply = parseReply(protocol, body)
    const chargeId = res.headers.get('x-client-request-id')
    return {
      ok: true,
      text: reply.text,
      truncated: reply.truncated,
      model: req.model,
      groupId,
      usage: reply.usage,
      chargeable: groupId !== null,
      ...(chargeId ? { chargeId } : {}),
    }
  }

  if (req.source === 'claude' || req.source === 'codex' || req.source === 'antigravity') {
    let reply: OneShotReply
    try {
      // 命令行没有单独的系统提示入口，说明和内容放在一条消息里
      reply = await deps.engine(
        req.source,
        { prompt: `${system}\n\n---\n\n${prompt}`, model: req.model || null },
        signal,
      )
    } catch (error) {
      const t = engineProblem(error, cancel)
      return failed(t.problem, t.detail)
    }
    return {
      ok: true,
      text: reply.text,
      // shortcut: 引擎的单次回答不报是否截断，这条通道截断了也照样换进去；要报得先让 oneShot 带回 stop_reason
      truncated: false,
      model: reply.model ?? req.model,
      groupId: null,
      usage: reply.usage,
      chargeable: false,
    }
  }

  if (req.source === 'platform') {
    const body = JSON.stringify(oneShotBody({ protocol: 'anthropic', model: req.model, system, prompt, maxTokens }))
    if (!req.groups.length) return failed('model')
    let last: Asked = failed('route')
    for (const groupId of req.groups) {
      let res: Response
      try {
        res = await deps.platform(body, groupId, signal)
      } catch (error) {
        const t = thrown(error, cancel)
        return failed(t.problem, t.detail)
      }
      if (res.ok) return finish(res, 'anthropic', groupId)
      const problem = platformProblem(res.status, await res.text().catch(() => ''))
      last = failed(problem.problem, problem.detail)
      // 线路拒绝（例如只允许 Claude Code 客户端）、这条线路没有这个模型：换下一条
      if (problem.problem !== 'route' && problem.problem !== 'model') break
    }
    return last
  }

  const p = req.providerId ? deps.provider(req.providerId) : null
  if (!p) return failed('provider', 'missing')
  if (!p.apiKey) return failed('provider', 'noKey')
  const url = upstreamUrl(p, PROTOCOL_PATH[p.protocol])
  let res: Response
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: providerHeaders(p, { 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify(oneShotBody({ protocol: p.protocol, model: req.model, system, prompt, maxTokens })),
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (cancel.aborted) return failed('cancelled')
    const c = classifyError(error, url)
    return failed(c.problem === 'timeout' ? 'timeout' : 'network', c.message)
  }
  if (!res.ok) {
    const c = classifyStatus(res.status, await res.text().catch(() => ''), p, req.model)
    const problem: AiProblem =
      c.problem === 'auth' || c.problem === 'not_found'
        ? 'provider'
        : c.problem === 'quota'
          ? 'rateLimit'
          : c.problem === 'model'
            ? 'model'
            : 'failed'
    return failed(problem, redact(c.message, p))
  }
  return finish(res, p.protocol, null)
}
