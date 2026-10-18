// 报错说人话（docs/ui/conversation-ux-2.md §2.1）：归类表用真实 Claude Code 2.1.296 对各种返回给出的原文
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineEvent, HostEvent } from '@pixelsky/protocol'
import { ClaudeAdapter, EngineHost } from '../src'
import { errorCodeFromText, friendlyApiError } from '../src/claude/apiError'
import { ClaudeTranslator } from '../src/claude/translate'
import { makeTmp, removeTmp } from './helpers/tmp'

const FAKE_CLAUDE = fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))

describe('报错归类', () => {
  // [合成消息的 error 代码, 原文, 期望的第一行]
  const cases: Array<[string, string, string]> = [
    [
      'authentication_failed',
      'Invalid API key · Fix external API key',
      'API Key 无效：检查环境变量里的 ANTHROPIC_API_KEY',
    ],
    [
      'authentication_failed',
      'Failed to authenticate. API Error: 403 Your API key does not have permission to use the specified resource.',
      '没有权限：当前账号或 API Key 不能用这个模型或资源',
    ],
    [
      'authentication_failed',
      'Please run /login · API Error: 401 OAuth token has expired',
      '登录已失效：在终端运行 claude auth login 重新登录',
    ],
    [
      'rate_limit',
      'API Error: Request rejected (429) · Number of request tokens has exceeded your per-minute rate limit',
      '请求太频繁（HTTP 429），已触发限额',
    ],
    [
      'server_error',
      'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      '服务繁忙（HTTP 529），请稍后再试',
    ],
    [
      'server_error',
      'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.',
      '服务出错（HTTP 500），通常是暂时的，稍后再试',
    ],
    [
      'server_error',
      'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
      '连不上模型服务：检查网络、代理或防火墙',
    ],
    [
      'invalid_request',
      'Prompt is too long · the request is ~250000 tokens (limit 200000) but this conversation is only ~2249 tokens',
      '上下文太长：先压缩（/compact）或开一个新会话',
    ],
    [
      'model_not_found',
      "There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it.",
      '找不到所选模型',
    ],
  ]

  it('按代码和原文给出第一行', () => {
    for (const [code, raw, want] of cases) expect(friendlyApiError(code, raw)).toBe(want)
  })

  it('接口返回的流不合规（第三方中转常见）：思考块格式、压缩拿到空总结、回复没发完；不管错误代码', () => {
    expect(friendlyApiError('unknown', 'API Error: Content block is not a thinking block')).toBe(
      '接口返回的思考内容格式不对（第三方中转常见）：对这个接口关掉思考，或者换一个接口',
    )
    const compact =
      '上下文太长，自动压缩也没成功：接口给压缩请求返回了空内容或没发完。可以开一个新会话，或换一个接口再压缩（/compact）'
    expect(
      friendlyApiError(
        'invalid_request',
        'Prompt is too long · automatic compaction failed: summarization produced empty response',
      ),
    ).toBe(compact)
    expect(
      friendlyApiError(
        null,
        'Prompt is too long · automatic compaction failed: API Error: Part of the response never arrived. The response above may be incomplete.',
      ),
    ).toBe(compact)
    expect(
      friendlyApiError(null, 'API Error: Part of the response never arrived. The response above may be incomplete.'),
    ).toBe('接口的回复没发完就断了，上面的内容可能不完整；可以重试，反复出现就换一个接口')
    // 只是上下文太长（压缩没失败）：照旧
    expect(friendlyApiError('invalid_request', 'Prompt is too long')).toBe(
      '上下文太长：先压缩（/compact）或开一个新会话',
    )
  })

  it('子智能体因 API 报错提前结束：警告里的报错也说人话', () => {
    const events: EngineEvent[] = []
    const t = new ClaudeTranslator('D:\\work', {
      emit: e => events.push(e),
      sessionId: () => {},
      permissionMode: () => {},
      turnEnded: () => {},
      fastState: () => {},
    })
    t.startTurn('turn-1')
    t.handle({
      type: 'system',
      subtype: 'task_started',
      task_id: 'a1',
      task_type: 'local_agent',
      description: 'x',
      is_backgrounded: true,
    })
    t.handle({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'a1',
      status: 'failed',
      summary: 'Agent terminated early due to an API error: Content block is not a thinking block (error type unknown)',
    })
    const notices = events.flatMap(e => (e.type === 'item_completed' && e.item.kind === 'notice' ? [e.item.text] : []))
    expect(notices.some(text => text.includes('接口返回的思考内容格式不对'))).toBe(true)
    expect(notices.some(text => text.includes('Content block'))).toBe(false)
  })

  it('没有合成消息时从原文认出类型；不像 API 报错的照原文', () => {
    expect(errorCodeFromText('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}')).toBe(
      'authentication_failed',
    )
    expect(errorCodeFromText('API Error: 529 Overloaded')).toBe('server_error')
    expect(friendlyApiError(null, 'API Error: Request rejected (429) · slow down')).toBe(
      '请求太频繁（HTTP 429），已触发限额',
    )
    expect(friendlyApiError(null, 'Error: file has 500 lines')).toBeNull()
    expect(friendlyApiError(null, '这一轮失败了')).toBeNull()
    expect(friendlyApiError('some_new_code', 'Something new')).toBeNull()
  })

  it('原文带中文（平台网关的说明）照原文', () => {
    expect(
      friendlyApiError(
        'authentication_failed',
        'Failed to authenticate. API Error: 401 平台账号已退出或切换，请重新登录原账号',
      ),
    ).toBeNull()
  })
})

describe('一次报错只提示一次', () => {
  let root: string
  let hosts: EngineHost[]
  beforeEach(() => {
    root = makeTmp('api-error')
    hosts = []
  })
  afterEach(async () => {
    await Promise.all(hosts.map(h => h.shutdown()))
    removeTmp(root)
  })

  it('合成的报错消息不当成回复；只出一条提示，原文在详情里；队列里的原因是说人话的那句', async () => {
    const events: HostEvent[] = []
    const projectsDir = join(root, 'claude-projects')
    const adapter = new ClaudeAdapter({
      launcher: { command: process.execPath, args: [FAKE_CLAUDE] },
      projectsDir,
      env: { ...process.env, FAKE_CLAUDE_PROJECTS: projectsDir },
    })
    const host = new EngineHost({
      dataDir: join(root, 'data'),
      emit: e => events.push(e),
      adapters: { claude: adapter },
    })
    hosts.push(host)
    const s = host.createSession({ projectId: host.addProject(root).id })
    await host.send(s.id, '认证失败')
    const t0 = Date.now()
    while (!events.some(e => e.kind === 'session' && e.sessionId === s.id && e.event.type === 'turn_completed')) {
      if (Date.now() - t0 > 10_000) throw new Error('等待超时')
      await new Promise(r => setTimeout(r, 20))
    }
    const { items, queue, record } = host.open(s.id)
    expect(items.some(i => i.kind === 'assistant')).toBe(false)
    const notices = items.filter(i => i.kind === 'notice')
    expect(notices).toEqual([
      expect.objectContaining({
        level: 'error',
        text: 'API Key 无效：检查环境变量里的 ANTHROPIC_API_KEY',
        detail: 'Invalid API key · Fix external API key',
      }),
    ])
    expect(queue.find(q => q.status === 'failed')?.error).toBe('API Key 无效：检查环境变量里的 ANTHROPIC_API_KEY')
    expect(record.lastError).toBe('API Key 无效：检查环境变量里的 ANTHROPIC_API_KEY')
  })
})

describe('不是合成的消息带错误代码', () => {
  it('max_output_tokens 的回复是真的：照旧显示回复和提示', () => {
    const events: EngineEvent[] = []
    const t = new ClaudeTranslator('D:\\work', {
      emit: e => events.push(e),
      sessionId: () => {},
      permissionMode: () => {},
      turnEnded: () => {},
      fastState: () => {},
    })
    t.startTurn('turn-1')
    t.handle({
      type: 'assistant',
      message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: '写到一半的回复' }] },
      error: 'max_output_tokens',
      parent_tool_use_id: null,
    })
    t.handle({ type: 'result', subtype: 'success', is_error: false, result: '写到一半的回复' })
    const items = events.flatMap(e => (e.type === 'item_completed' ? [e.item] : []))
    expect(items).toEqual([
      expect.objectContaining({ kind: 'assistant', text: '写到一半的回复' }),
      expect.objectContaining({ kind: 'notice', level: 'error', text: '回复超过了最大长度' }),
    ])
  })
})
