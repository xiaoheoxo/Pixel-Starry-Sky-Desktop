import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineEvent, HostEvent } from '@pixelsky/protocol'
import { EngineHost, ENGINES } from '../src'
import { retryLimit } from '../src/retry'
import { claudeSettingsArgument } from '../src/claude/session'
import { ClaudeTranslator } from '../src/claude/translate'

const roots: string[] = []
const adapter = {
  info: async () => ({ ...ENGINES.claude, status: 'ready' as const, version: 'test', path: 'test', message: null }),
  createSession: () => ({
    send: () => {},
    interrupt: async () => {},
    answer: () => {},
    update: async () => {},
    stopTask: async () => {},
    taskOutput: async () => ({ output: '', truncated: false }),
    close: async () => {},
  }),
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('自定义请求重试设置', () => {
  it('接受 null/0～15，拒绝小数、负数和越界', () => {
    expect(retryLimit(null)).toBeNull()
    expect(retryLimit(0)).toBe(0)
    expect(retryLimit(15)).toBe(15)
    for (const value of [-1, 16, 1.5, Number.NaN, '3']) expect(() => retryLimit(value)).toThrow('0～15')
  })
  it('设置文件保存并在重启后恢复，0 不被当成缺省', () => {
    const root = mkdtempSync(join(tmpdir(), 'pixelsky-retry-settings-'))
    roots.push(root)
    const events: HostEvent[] = []
    const host = new EngineHost({
      dataDir: join(root, 'data'),
      adapters: { claude: adapter },
      emit: e => events.push(e),
    })
    expect(host.retrySettings()).toEqual({ maxRetries: null })
    expect(host.setRetrySettings(0)).toEqual({ maxRetries: 0 })
    expect(host.retrySettings()).toEqual({ maxRetries: 0 })
    expect(events.at(-1)).toEqual({ kind: 'retry_settings', settings: { maxRetries: 0 } })
    const again = new EngineHost({ dataDir: join(root, 'data'), adapters: { claude: adapter }, emit: () => {} })
    expect(again.retrySettings()).toEqual({ maxRetries: 0 })
  })
  it('自有与平台代理都能把自定义上限注入 Claude settings，跟随引擎保留原环境', () => {
    const root = mkdtempSync(join(tmpdir(), 'pixelsky-retry-file-'))
    roots.push(root)
    const gateway = join(root, 'gateway.json')
    writeFileSync(
      gateway,
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'secret' } }),
    )
    const retryFile = claudeSettingsArgument(gateway, 3)
    expect(retryFile).not.toBe(gateway)
    expect(JSON.parse(readFileSync(retryFile!, 'utf8')).env.CLAUDE_CODE_MAX_RETRIES).toBe('3')
    const self = claudeSettingsArgument(undefined, 0)
    expect(JSON.parse(self!).env.CLAUDE_CODE_MAX_RETRIES).toBe('0')
  })
  it('重试事件按序更新、重复事件不重复生成，下一次请求清空状态', () => {
    const events: EngineEvent[] = []
    const t = new ClaudeTranslator('D:/work', {
      emit: e => events.push(e),
      sessionId: () => {},
      permissionMode: () => {},
      turnEnded: () => {},
      fastState: () => {},
    })
    t.startTurn('t1')
    const frame = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 100,
      error_status: 503,
    }
    t.handle(frame)
    t.handle(frame)
    expect(events.filter(e => e.type === 'request_retry')).toEqual([
      {
        type: 'request_retry',
        retry: expect.objectContaining({ attempt: 1, maxRetries: 3, reason: 'HTTP 503', scope: 'turn' }),
      },
    ])
    t.handle({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm', model: 'opus' } } })
    expect(events.at(-1)).toEqual({ type: 'request_retry', retry: null })
  })
})
