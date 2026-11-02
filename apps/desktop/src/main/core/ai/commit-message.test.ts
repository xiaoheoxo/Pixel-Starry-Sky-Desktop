// AI 写提交信息（docs/ui/ai-commit-codex-warnings-history.md §2）：拼提示、清理返回、出错原因、换线路、自定义 API
import { describe, expect, it } from 'vitest'
import type { AiCommitRequest } from '../../../shared/types/ai'
import type { GitCommitContext } from '../../../shared/types/project-tools'
import type { ResolvedProvider } from '../providers/store'
import {
  cleanMessage,
  commitPrompt,
  platformProblem,
  writeCommitMessage,
  type CommitMessageDeps,
} from './commit-message'
import { oneShotBody, parseReply } from './oneshot'
import { optimizePrompt } from './prompt-optimize'

const context: GitCommitContext = {
  scope: 'staged',
  branch: 'fix/login',
  files: [
    { path: 'src/a.ts', origPath: null, code: 'M', insertions: 2, deletions: 1, content: 'diff' },
    { path: 'pnpm-lock.yaml', origPath: null, code: 'M', insertions: 40, deletions: 3, content: 'listed' },
    { path: '.env', origPath: null, code: 'A', insertions: 1, deletions: 0, content: 'secret' },
    { path: 'b.ts', origPath: 'old.ts', code: 'R', insertions: 0, deletions: 0, content: 'omitted' },
  ],
  patch: 'diff --git a/src/a.ts b/src/a.ts\n-old\n+new\n',
  recent: ['fix: 修好登录', 'feat: 加设置页'],
  truncated: false,
}
const request: AiCommitRequest = {
  requestId: 'r1',
  ref: { projectId: 'p' },
  scope: 'staged',
  source: 'platform',
  groups: ['7', '9'],
  providerId: null,
  model: 'claude-opus-5-5',
  language: 'auto',
  uiLanguage: 'zh',
  style: 'body',
  instructions: '',
}
const anthropicReply = (text: string, init: ResponseInit = {}) =>
  new Response(
    JSON.stringify({ content: [{ type: 'text', text }], usage: { input_tokens: 1200, output_tokens: 30 } }),
    { status: 200, ...init },
  )
const provider: ResolvedProvider = {
  id: 'my',
  name: '我的接口',
  template: 'custom',
  protocol: 'responses',
  baseUrl: 'https://api.example.test/v1',
  auth: 'bearer',
  models: [{ id: 'gpt-x' } as ResolvedProvider['models'][number]],
  smallModel: null,
  modelFallback: false,
  headerNames: [],
  createdAt: 0,
  updatedAt: 0,
  apiKey: 'sk-secret-key',
  headers: {},
}

function deps(over: Partial<CommitMessageDeps> = {}): CommitMessageDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    context: async () => context,
    platform: async (_body, groupId) => {
      calls.push(groupId)
      return anthropicReply('fix: 登录')
    },
    provider: () => null,
    fetch: async () => new Response('{}'),
    engine: async () => ({ text: '', model: null, usage: null }),
    ...over,
  }
}

describe('commitPrompt', () => {
  it('写清分支、最近标题、每个文件的情况和改动正文；不放只列名字的文件内容', () => {
    const { system, prompt } = commitPrompt(context, request)
    expect(prompt).toContain('Branch: fix/login')
    expect(prompt).toContain('- fix: 修好登录')
    expect(prompt).toContain('M src/a.ts (+2 -1)\n')
    expect(prompt).toContain('M pnpm-lock.yaml (+40 -3) [lock or generated file, content not included]')
    expect(prompt).toContain('A .env (+1 -0) [may contain secrets, content withheld]')
    expect(prompt).toContain('R old.ts → b.ts (+0 -0) [diff not included: size limit]')
    expect(prompt).toContain('+new')
    expect(system).toContain(
      'Match the language of the recent commit subjects; if there are none, write in Simplified Chinese.',
    )
    expect(system).toContain('add a blank line and a short body')
    expect(system).not.toContain('Additional instructions')
  })
  it('指定语言、只写标题、额外要求', () => {
    const { system } = commitPrompt(context, {
      ...request,
      language: 'en',
      style: 'subject',
      instructions: ' 用 Conventional Commits ',
    })
    expect(system).toContain('Write in English.')
    expect(system).toContain('Write only the subject line.')
    expect(system).toContain('Additional instructions from the user:\n用 Conventional Commits')
  })
  it('还没有提交的仓库', () => {
    expect(commitPrompt({ ...context, recent: [], branch: null }, request).prompt).toContain(
      'Branch: (detached HEAD)\n\nThis repository has no commits yet.',
    )
  })
})

describe('cleanMessage', () => {
  it('去掉代码块、引号、开头的标签和多余空行', () => {
    expect(cleanMessage('```text\nfix: 登录\n\n- 改了 a\n```')).toBe('fix: 登录\n\n- 改了 a')
    expect(cleanMessage('"fix: quoted"')).toBe('fix: quoted')
    expect(cleanMessage('Commit message: feat: x')).toBe('feat: x')
    expect(cleanMessage('提交信息：修复登录')).toBe('修复登录')
    expect(cleanMessage('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb')
    expect(cleanMessage('   ')).toBe('')
  })
  it('引号不在两头成对时不动', () => {
    expect(cleanMessage('fix: 处理 "a" 和 "b"')).toBe('fix: 处理 "a" 和 "b"')
  })
})

describe('platformProblem', () => {
  it('按状态码和说明分原因', () => {
    expect(platformProblem(401, '').problem).toBe('signedOut')
    expect(platformProblem(402, '').problem).toBe('balance')
    expect(platformProblem(403, '{"error":{"message":"Insufficient balance"}}').problem).toBe('balance')
    expect(platformProblem(403, '{"error":"this group only allows Claude Code"}')).toEqual({
      problem: 'route',
      detail: 'this group only allows Claude Code',
    })
    expect(platformProblem(400, '{"error":{"message":"model not found"}}').problem).toBe('model')
    expect(platformProblem(429, '').problem).toBe('rateLimit')
    expect(platformProblem(500, '')).toEqual({ problem: 'failed', detail: 'HTTP 500' })
  })
})

describe('oneShot', () => {
  it('两种格式的请求体和回复', () => {
    const r = { model: 'm', system: 's', prompt: 'p', maxTokens: 9 }
    expect(oneShotBody({ ...r, protocol: 'anthropic' })).toEqual({
      model: 'm',
      max_tokens: 9,
      system: 's',
      messages: [{ role: 'user', content: 'p' }],
    })
    expect(oneShotBody({ ...r, protocol: 'responses' })).toEqual({
      model: 'm',
      instructions: 's',
      input: 'p',
      max_output_tokens: 9,
      store: false,
    })
    expect(
      parseReply('responses', {
        output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
        usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 40 } },
      }),
    ).toEqual({ text: 'hi', truncated: false, usage: { input: 60, output: 5, cacheRead: 40, cacheWrite: 0 } })
    expect(parseReply('anthropic', { nope: 1 })).toEqual({ text: '', truncated: false, usage: null })
    expect(parseReply('anthropic', { content: [], stop_reason: 'max_tokens' }).truncated).toBe(true)
    expect(parseReply('chat', { choices: [{ message: { content: 'a' }, finish_reason: 'length' }] }).truncated).toBe(
      true,
    )
    expect(parseReply('responses', { output_text: 'a', status: 'incomplete' }).truncated).toBe(true)
  })
})

describe('writeCommitMessage', () => {
  const never = new AbortController().signal

  it('云端：用第一条线路，返回清理过的信息、用量和计费 ID', async () => {
    const d = deps({
      platform: async (body, groupId) => {
        d.calls.push(groupId)
        expect(JSON.parse(body)).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 1024 })
        return anthropicReply('```\nfix: 登录\n```', { headers: { 'x-client-request-id': 'charge-1' } })
      },
    })
    expect(await writeCommitMessage(d, request, never)).toEqual({
      ok: true,
      message: 'fix: 登录',
      model: 'claude-opus-5-5',
      groupId: '7',
      usage: { input: 1200, output: 30, cacheRead: 0, cacheWrite: 0 },
      partial: 1,
      chargeable: true,
      chargeId: 'charge-1',
    })
    expect(d.calls).toEqual(['7'])
  })

  it('云端：线路拒绝时换下一条；余额不足不再换', async () => {
    const d = deps({
      platform: async (_b, groupId) => {
        d.calls.push(groupId)
        return groupId === '7' ? new Response('{"error":"only Claude Code"}', { status: 403 }) : anthropicReply('ok')
      },
    })
    expect(await writeCommitMessage(d, request, never)).toMatchObject({ ok: true, groupId: '9' })
    expect(d.calls).toEqual(['7', '9'])

    const poor = deps({
      platform: async (_b, groupId) => {
        poor.calls.push(groupId)
        return new Response('{"error":"insufficient balance"}', { status: 402 })
      },
    })
    expect(await writeCommitMessage(poor, request, never)).toEqual({
      ok: false,
      problem: 'balance',
      detail: 'insufficient balance',
    })
    expect(poor.calls).toEqual(['7'])
  })

  it('没登录、没有改动、模型没写出东西、没有可用线路', async () => {
    const out = deps({
      platform: async () => {
        throw Object.assign(new Error('登录已过期'), { code: 'AUTH_EXPIRED' })
      },
    })
    expect(await writeCommitMessage(out, request, never)).toMatchObject({ ok: false, problem: 'signedOut' })
    expect(
      await writeCommitMessage(deps({ context: async () => ({ ...context, files: [], patch: '' }) }), request, never),
    ).toMatchObject({ ok: false, problem: 'nothing' })
    expect(
      await writeCommitMessage(deps({ platform: async () => anthropicReply('  ') }), request, never),
    ).toMatchObject({ ok: false, problem: 'empty' })
    expect(await writeCommitMessage(deps(), { ...request, groups: [] }, never)).toMatchObject({
      ok: false,
      problem: 'model',
    })
  })

  it('停止：请求中途停下，返回 cancelled', async () => {
    const stop = new AbortController()
    const d = deps({
      platform: (_b, _g, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          setTimeout(() => stop.abort(), 5)
        }),
    })
    expect(await writeCommitMessage(d, request, stop.signal)).toEqual({ ok: false, problem: 'cancelled', detail: '' })
  })

  it('自定义 API：用接口配置的地址和 Key；出错时说明里不带 Key', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const custom = { ...request, source: 'custom' as const, groups: [], providerId: 'my', model: 'gpt-x' }
    const ok = deps({
      provider: id => (id === 'my' ? provider : null),
      fetch: async (url, init) => {
        seen.push({ url, init })
        return new Response(JSON.stringify({ output_text: 'feat: 新功能' }), { status: 200 })
      },
    })
    expect(await writeCommitMessage(ok, custom, never)).toMatchObject({
      ok: true,
      message: 'feat: 新功能',
      groupId: null,
      chargeable: false,
    })
    expect(seen[0].url).toBe('https://api.example.test/v1/responses')
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret-key')
    expect(JSON.parse(String(seen[0].init.body))).toMatchObject({ model: 'gpt-x', store: false })

    const denied = deps({
      provider: () => provider,
      fetch: async () => new Response('{"error":{"message":"bad key sk-secret-key"}}', { status: 401 }),
    })
    const result = await writeCommitMessage(denied, custom, never)
    expect(result).toMatchObject({ ok: false, problem: 'provider' })
    expect(JSON.stringify(result)).not.toContain('sk-secret-key')

    expect(await writeCommitMessage(deps(), custom, never)).toEqual({
      ok: false,
      problem: 'provider',
      detail: 'missing',
    })
    expect(await writeCommitMessage(deps({ provider: () => ({ ...provider, apiKey: null }) }), custom, never)).toEqual({
      ok: false,
      problem: 'provider',
      detail: 'noKey',
    })
  })

  it('Claude / ChatGPT 授权：本机引擎问一次，说明和改动在一条消息里；不扣余额', async () => {
    const asked: unknown[] = []
    const d = deps({
      engine: async (engine, req) => {
        asked.push(engine, req.model)
        expect(req.prompt).toContain('You write git commit messages.')
        expect(req.prompt).toContain('Branch: fix/login')
        return {
          text: '"fix: 登录"',
          model: 'claude-haiku-4-5',
          usage: { input: 9, output: 2, cacheRead: 0, cacheWrite: 0 },
        }
      },
    })
    expect(await writeCommitMessage(d, { ...request, source: 'claude', model: 'haiku', groups: [] }, never)).toEqual({
      ok: true,
      message: 'fix: 登录',
      model: 'claude-haiku-4-5',
      groupId: null,
      usage: { input: 9, output: 2, cacheRead: 0, cacheWrite: 0 },
      partial: 1,
      chargeable: false,
    })
    // 模型留空：跟随引擎自己的设置
    await writeCommitMessage(d, { ...request, source: 'codex', model: '' }, never)
    expect(asked).toEqual(['claude', 'haiku', 'codex', null])
    expect(d.calls).toEqual([])
  })

  it('Claude / ChatGPT 授权：没装、没授权、额度用完照原因报；总超时不当成停止', async () => {
    const thrower = (kind: string, message: string) =>
      deps({ engine: async () => Promise.reject(Object.assign(new Error(message), { kind })) })
    const claude = { ...request, source: 'claude' as const }
    expect(await writeCommitMessage(thrower('usageLimit', 'resets 3pm'), claude, never)).toEqual({
      ok: false,
      problem: 'usageLimit',
      detail: 'resets 3pm',
    })
    expect((await writeCommitMessage(thrower('notInstalled', 'x'), claude, never)).ok).toBe(false)
    expect(await writeCommitMessage(thrower('notAuthorized', 'x'), claude, never)).toMatchObject({
      problem: 'notAuthorized',
    })
    expect(await writeCommitMessage(thrower('cancelled', ''), claude, never)).toMatchObject({ problem: 'timeout' })
    expect(await writeCommitMessage(thrower('weird', 'boom'), claude, never)).toMatchObject({
      problem: 'failed',
      detail: 'boom',
    })
    const stop = new AbortController()
    stop.abort()
    const d = thrower('cancelled', '')
    expect(await writeCommitMessage({ ...d, context: async () => context }, claude, stop.signal)).toMatchObject({
      problem: 'cancelled',
    })
    expect(
      await writeCommitMessage(deps({ engine: async () => ({ text: ' ', model: null, usage: null }) }), claude, never),
    ).toMatchObject({ problem: 'empty' })
  })
})

describe('optimizePrompt', () => {
  const never = new AbortController().signal
  const req = {
    requestId: 'r2',
    source: 'platform' as const,
    groups: ['7'],
    providerId: null,
    model: 'claude-opus-5-5',
  }

  it('带上下文和原文发一次，返回改写后的全文；不带改动、不取 git', async () => {
    let sent: { system?: string; messages?: Array<{ content: string }> } = {}
    const d = deps({
      context: async () => Promise.reject(new Error('不该取改动')),
      platform: async body => {
        sent = JSON.parse(body)
        return anthropicReply('"把登录页的报错改成中文"')
      },
    })
    const out = await optimizePrompt(d, { ...req, text: '登录报错改中文', context: '项目：web' }, never)
    expect(out).toMatchObject({ ok: true, message: '把登录页的报错改成中文', partial: 0, groupId: '7' })
    expect(sent.system).toContain('rewrite')
    expect(sent.messages?.[0].content).toBe(
      'Context (for reference only, do not repeat it):\n项目：web\n\nMessage to rewrite:\n登录报错改中文',
    )
  })

  it('写到上限被截断：不换进去，报太长', async () => {
    const cut = new Response(
      JSON.stringify({ content: [{ type: 'text', text: '写到一半' }], stop_reason: 'max_tokens' }),
    )
    expect(
      await optimizePrompt(deps({ platform: async () => cut }), { ...req, text: 'x', context: '' }, never),
    ).toEqual({ ok: false, problem: 'tooLong', detail: '' })
  })

  it('没写出东西、出错照原因报', async () => {
    expect(
      await optimizePrompt(
        deps({ platform: async () => anthropicReply(' ') }),
        { ...req, text: 'x', context: '' },
        never,
      ),
    ).toMatchObject({ ok: false, problem: 'empty' })
    expect(await optimizePrompt(deps(), { ...req, groups: [], text: 'x', context: '' }, never)).toMatchObject({
      ok: false,
      problem: 'model',
    })
  })
})
