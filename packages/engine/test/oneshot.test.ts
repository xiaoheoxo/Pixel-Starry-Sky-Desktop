// 单独问一次（AI 写提交信息的 Claude 授权 / ChatGPT 授权通道，docs/ui/ai-commit-channels.md §4）
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OneShotError, oneShotProblem } from '../src/oneshot'
import { oneShotArgs, oneShotOnce, parseOneShot } from '../src/claude/helper'
import { codexOneShot, codexOneShotProblem } from '../src/codex/oneshot'

const FAKE_CLAUDE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))
const FAKE_CODEX = fileURLToPath(new URL('./fakes/fake-codex.mjs', import.meta.url))
const env = (): NodeJS.ProcessEnv => {
  const e = { ...process.env }
  delete e.FAKE_CLAUDE_CHAIN
  return e
}
const caught = async (p: Promise<unknown>): Promise<OneShotError> => {
  const e = await p.then(
    () => null,
    (error: unknown) => error,
  )
  expect(e).toBeInstanceOf(OneShotError)
  return e as OneShotError
}

describe('oneShotProblem', () => {
  it('认出额度用完、没授权、模型不对', () => {
    expect(oneShotProblem("You've hit your usage limit · resets 3pm")).toBe('usageLimit')
    expect(oneShotProblem('Claude AI usage limit reached|1760000000')).toBe('usageLimit')
    expect(oneShotProblem('Invalid API key · Please run /login')).toBe('notAuthorized')
    expect(oneShotProblem('Not logged in')).toBe('notAuthorized')
    expect(oneShotProblem('model: claude-x not found')).toBe('model')
    expect(oneShotProblem('socket hang up')).toBe('failed')
  })

  it('Codex 按 codexErrorInfo 分类，认不出时看原话', () => {
    expect(codexOneShotProblem({ message: 'x', codexErrorInfo: 'usageLimitExceeded' })).toBe('usageLimit')
    expect(codexOneShotProblem({ message: 'x', codexErrorInfo: 'unauthorized' })).toBe('notAuthorized')
    expect(
      codexOneShotProblem({ message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }),
    ).toBe('notAuthorized')
    expect(codexOneShotProblem({ message: 'model gpt-x not supported' })).toBe('model')
    expect(codexOneShotProblem(null)).toBe('failed')
  })
})

describe('Claude 单独问一次', () => {
  it('参数：不留会话、不带工具和 MCP，模型可选', () => {
    expect(oneShotArgs(null)).toEqual([
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--tools',
      '',
      '--strict-mcp-config',
    ])
    expect(oneShotArgs('haiku').slice(-2)).toEqual(['--model', 'haiku'])
  })

  it('解析结果：正文、模型、用量；is_error 时按原话报原因', () => {
    const reply = parseOneShot(
      'noise\n' +
        JSON.stringify({
          type: 'result',
          is_error: false,
          result: 'feat: 加按钮',
          usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 1 },
          modelUsage: { 'claude-haiku-4-5': {} },
        }),
    )
    expect(reply).toEqual({
      text: 'feat: 加按钮',
      model: 'claude-haiku-4-5',
      usage: { input: 5, output: 2, cacheRead: 7, cacheWrite: 1 },
    })
    expect(parseOneShot(JSON.stringify({ result: 'x' }))).toEqual({ text: 'x', model: null, usage: null })
    try {
      parseOneShot(JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }))
      expect.unreachable()
    } catch (e) {
      expect((e as OneShotError).kind).toBe('notAuthorized')
    }
  })

  it('跑一次假 CLI：提示走 stdin，带上模型', async () => {
    const reply = await oneShotOnce(
      { command: process.execPath, args: [FAKE_CLAUDE] },
      env(),
      { prompt: '规则\n写一条提交信息', model: 'haiku' },
      new AbortController().signal,
    )
    expect(reply.text).toBe('收到：写一条提交信息｜模型=haiku')
    expect(reply.model).toBe('haiku')
    expect(reply.usage).toEqual({ input: 12, output: 3, cacheRead: 40, cacheWrite: 0 })
  })

  it('额度用完报 usageLimit；已停止的请求不启动', async () => {
    const launcher = { command: process.execPath, args: [FAKE_CLAUDE] }
    const e = await caught(
      oneShotOnce(launcher, env(), { prompt: '额度用完', model: null }, new AbortController().signal),
    )
    expect(e.kind).toBe('usageLimit')
    const stop = new AbortController()
    stop.abort()
    expect((await caught(oneShotOnce(launcher, env(), { prompt: 'x', model: null }, stop.signal))).kind).toBe(
      'cancelled',
    )
  })
})

describe('Codex 单独问一次', () => {
  const launcher = { command: process.execPath, args: [FAKE_CODEX] }

  it('开临时线程发一条，取最后的回复和用量', async () => {
    const reply = await codexOneShot(
      launcher,
      [],
      { ...process.env, FAKE_CODEX_THREAD_MODEL: 'gpt-mini' },
      { prompt: '写一条提交信息', model: 'gpt-mini' },
      new AbortController().signal,
    )
    expect(reply).toEqual({
      text: '收到：写一条提交信息',
      model: 'gpt-mini',
      usage: { input: 50, output: 10, cacheRead: 50, cacheWrite: 0 },
    })
  })

  it('requires an explicit ephemeral result for Agnes before sending user text', async () => {
    const run = (state: string) =>
      codexOneShot(
        launcher,
        [],
        { ...process.env, FAKE_CODEX_THREAD_MODEL: 'gpt-mini', FAKE_CODEX_ADVISOR: state },
        { prompt: 'private text', model: 'gpt-mini', requireEphemeral: true },
        new AbortController().signal,
      )
    expect((await caught(run('missing'))).message).toContain('not confirmed ephemeral')
    expect((await run('confirmed')).text).toContain('private text')
  })

  it('额度用完报 usageLimit', async () => {
    const e = await caught(
      codexOneShot(launcher, [], process.env, { prompt: '额度用完', model: null }, new AbortController().signal),
    )
    expect(e.kind).toBe('usageLimit')
  })

  it('中途停止报 cancelled', async () => {
    const stop = new AbortController()
    const p = codexOneShot(launcher, [], process.env, { prompt: '缓停', model: null }, stop.signal)
    setTimeout(() => stop.abort(), 300)
    expect((await caught(p)).kind).toBe('cancelled')
  })

  it('进程起不来报错，不挂住', async () => {
    const e = await caught(
      codexOneShot(
        { command: process.execPath, args: ['-e', 'process.exit(2)'] },
        [],
        process.env,
        { prompt: 'x', model: null },
        new AbortController().signal,
      ),
    )
    expect(e.kind).toBe('failed')
  })
})
