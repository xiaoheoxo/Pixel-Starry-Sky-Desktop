import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { type ApprovalDecision, type EngineId, type SessionSettings, subagentConfig } from '@pixelsky/protocol'
import { ClaudeAdapter, EngineHost, type EngineHostOptions } from '../src'
import type { EngineAdapter, EngineSession, SessionContext } from '../src/adapter'
import { engineBase } from '../src/registry'

class FakeSession implements EngineSession {
  sent = ''
  closed = false
  patches: Array<Partial<SessionSettings>> = []
  answers: Array<{ requestId: string; decision: ApprovalDecision }> = []
  constructor(readonly ctx: SessionContext) {}
  send(text: string): void {
    this.sent = text
    this.ctx.setEngineSessionId('native-' + this.ctx.record().id)
  }
  update(patch: Partial<SessionSettings>): Promise<void> {
    this.patches.push(patch)
    return Promise.resolve()
  }
  interrupt(): Promise<void> {
    return Promise.resolve()
  }
  answer(requestId: string, decision: ApprovalDecision): void {
    this.answers.push({ requestId, decision })
    this.ctx.emit({ type: 'approval_resolved', requestId })
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
  complete(text = 'B 的独立报告'): void {
    this.ctx.emit({ type: 'item_completed', item: { kind: 'assistant', id: 'reply', text, status: 'completed' } })
    this.ctx.emit({ type: 'turn_completed', turnId: this.ctx.record().id, outcome: 'completed', error: null })
  }
}
class FakeAdapter implements EngineAdapter {
  sessions: FakeSession[] = []
  constructor(readonly id: EngineId) {}
  info() {
    return Promise.resolve({
      ...engineBase(this.id),
      status: 'ready' as const,
      version: null,
      path: 'fake',
      message: null,
    })
  }
  createSession(ctx: SessionContext) {
    const session = new FakeSession(ctx)
    this.sessions.push(session)
    return session
  }
}

const roots: string[] = []
const hosts: EngineHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(h => h.shutdown()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const task = { description: '检查组件', prompt: '检查 src 下的组件并报告问题。' }
async function waitFor(check: () => boolean): Promise<void> {
  for (let n = 0; n < 100; n++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('等待测试事件超时')
}
async function setup(options: Partial<EngineHostOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pixelsky-delegation-'))
  roots.push(root)
  const claude = new FakeAdapter('claude'),
    pixel = new FakeAdapter('pixel')
  const opts = {
    dataDir: join(root, 'data'),
    emit: () => {},
    adapters: { claude, pixel },
    subagentSite: () => '站点 B',
    ...options,
  }
  const host = new EngineHost(opts)
  hosts.push(host)
  const project = host.addProject(root)
  const parent = host.createSession({
    projectId: project.id,
    engine: 'claude',
    model: 'A',
    subagent: { source: 'custom', providerId: 'site-b', model: 'B' },
  })
  await host.send(parent.id, '请检查项目')
  await waitFor(() => claude.sessions.length === 1 && host.open(parent.id).state === 'running')
  return { host, parent, claude, pixel, root, opts }
}

describe('宿主管理的独立子代理', () => {
  it('A 派任务给独立站点 B，修改设置不改变运行中任务，报告返回并持久化', async () => {
    const { host, parent, pixel, root, opts } = await setup()
    const result = host.delegate(parent.id, task)
    await waitFor(() => pixel.sessions.length === 1)
    const child = pixel.sessions[0],
      record = child.ctx.record()
    expect(record).toMatchObject({
      model: 'B',
      provider: { id: 'site-b' },
      platform: null,
      engine: 'pixel',
      subagentParentId: parent.id,
      subagent: null,
    })
    expect(record.id).not.toBe(parent.id)
    expect(record.engineSessionId).not.toBe(parent.engineSessionId)
    expect(child.sent).toContain(task.prompt)
    await host.update(parent.id, { subagent: { source: 'custom', providerId: 'site-c', model: 'C' } })
    expect(child.ctx.record()).toMatchObject({ model: 'B', provider: { id: 'site-b' } })
    child.complete()
    await expect(result).resolves.toBe('B 的独立报告')
    expect(child.closed).toBe(true)
    const stored = JSON.parse(readFileSync(join(root, 'data', 'sessions', parent.id, 'subagents.json'), 'utf8'))
    expect(Object.keys(stored[0]).sort()).toEqual(['record', 'run'])
    expect(host.sessions().map(s => s.record.id)).toEqual([parent.id])
    expect(host.open(parent.id).runs.agents).toContainEqual(
      expect.objectContaining({ id: record.id, site: '站点 B', model: 'B', state: 'completed' }),
    )
    expect(await host.subagentTranscript(parent.id, record.id)).toContainEqual(
      expect.objectContaining({ kind: 'assistant', text: 'B 的独立报告' }),
    )
    await host.shutdown()
    const restored = new EngineHost({ ...opts, dataDir: join(root, 'data') })
    hosts.push(restored)
    expect(restored.sessions()).toHaveLength(1)
    expect(restored.open(parent.id).runs.agents).toContainEqual(
      expect.objectContaining({ id: record.id, state: 'completed', model: 'B' }),
    )
    expect(restored.open(parent.id).record.subagent).toMatchObject({ providerId: 'site-c', model: 'C' })
  })

  it('审批回到主会话并正确路由应答，权限变更同步到子代理', async () => {
    const { host, parent, pixel } = await setup()
    const result = host.delegate(parent.id, task)
    await waitFor(() => pixel.sessions.length === 1)
    const child = pixel.sessions[0]
    child.ctx.emit({
      type: 'approval_request',
      request: {
        requestId: 'write',
        itemId: null,
        kind: 'command',
        title: '执行命令',
        command: 'test',
        alwaysScopes: [],
      },
    })
    const approval = host.open(parent.id).pending[0]
    expect(approval.title).toContain(task.description)
    expect(host.open(parent.id).state).toBe('waiting')
    host.answer(parent.id, approval.requestId, { type: 'allow' })
    expect(child.answers).toEqual([{ requestId: 'write', decision: { type: 'allow' } }])
    expect(host.open(parent.id).pending).toHaveLength(0)
    await host.update(parent.id, { permissionMode: 'plan' })
    expect(child.ctx.record().permissionMode).toBe('plan')
    expect(child.patches).toContainEqual({ permissionMode: 'plan' })
    child.complete()
    await result
  })

  it('原生追踪事件不能覆盖宿主子任务；可单独停止且不会遗留审批', async () => {
    const { host, parent, claude, pixel } = await setup()
    const result = host.delegate(parent.id, task)
    const failure = expect(result).rejects.toThrow('已停止')
    await waitFor(() => pixel.sessions.length === 1)
    const child = pixel.sessions[0],
      id = child.ctx.record().id
    claude.sessions[0].ctx.emit({ type: 'runs', runs: { agents: [], workflows: [] } })
    claude.sessions[0].ctx.emit({ type: 'subagents', subagents: [] })
    expect(host.open(parent.id).runs.agents.some(a => a.id === id)).toBe(true)
    expect(host.open(parent.id).subagents.some(a => a.id === id)).toBe(true)
    child.ctx.emit({
      type: 'approval_request',
      request: { requestId: 'x', itemId: null, kind: 'tool', title: '测试', alwaysScopes: [] },
    })
    await host.stopTask(parent.id, id)
    await failure
    expect(child.closed).toBe(true)
    expect(host.open(parent.id).pending).toHaveLength(0)
    expect(host.open(parent.id).runs.agents.find(a => a.id === id)?.state).toBe('stopped')
    child.complete('迟到的结果')
    expect(host.open(parent.id).runs.agents.find(a => a.id === id)?.state).toBe('stopped')
  })

  it('预检失败向 A 返回错误，不启动 B、不回退其他站点', async () => {
    const { host, parent, pixel } = await setup({
      validateInput: async r => {
        if (r.subagentParentId) throw new Error('子代理站点已删除')
      },
    })
    await expect(host.delegate(parent.id, task)).rejects.toThrow('站点已删除')
    expect(pixel.sessions).toHaveLength(0)
    expect(host.open(parent.id).runs.agents[0].state).toBe('failed')
  })

  it('取消派发与停止主会话都会终止子任务', async () => {
    const { host, parent, pixel } = await setup()
    const abort = new AbortController()
    const result = host.delegate(parent.id, task, abort.signal)
    const failure = expect(result).rejects.toThrow('已取消')
    abort.abort()
    await failure
    expect(pixel.sessions).toHaveLength(0)
    const next = host.delegate(parent.id, task)
    const stopped = expect(next).rejects.toThrow('已停止')
    await waitFor(() => pixel.sessions.length === 1)
    await host.interrupt(parent.id)
    await stopped
    expect(pixel.sessions[0].closed).toBe(true)
  })

  it('跟随主会话使用原引擎和主模型，保持独立上下文', async () => {
    const { host, parent, claude, pixel } = await setup()
    await host.update(parent.id, { subagent: null })
    const result = host.delegate(parent.id, task)
    await waitFor(() => claude.sessions.length === 2)
    expect(pixel.sessions).toHaveLength(0)
    expect(claude.sessions[1].ctx.record()).toMatchObject({
      model: 'A',
      engine: 'claude',
      platform: null,
      provider: null,
    })
    expect(claude.sessions[1].sent).not.toContain('请检查项目')
    claude.sessions[1].complete()
    await result
  })

  it('配置校验拒绝额外来源、非法 id、空模型；保存失败保持旧配置', async () => {
    expect(() => subagentConfig({ source: 'custom', providerId: '../x', model: 'B' })).toThrow()
    expect(() => subagentConfig({ source: 'custom', providerId: 'b', model: ' ' })).toThrow()
    expect(() => subagentConfig({ source: 'self', model: 'B' })).toThrow()
    const { host, parent } = await setup({
      validateSubagent: async () => {
        throw new Error('模型不可用')
      },
    })
    await expect(
      host.update(parent.id, { subagent: { source: 'custom', providerId: 'c', model: 'C' } }),
    ).rejects.toThrow('模型不可用')
    expect(host.open(parent.id).record.subagent).toMatchObject({ providerId: 'site-b', model: 'B' })
  })

  it('主请求异常结束时停止子任务；不允许子会话继续派代理', async () => {
    const { host, parent, claude, pixel } = await setup()
    const result = host.delegate(parent.id, task)
    const failure = expect(result).rejects.toThrow('已停止')
    await waitFor(() => pixel.sessions.length === 1)
    const child = pixel.sessions[0]
    await expect(host.delegate(child.ctx.record().id, task)).rejects.toThrow('无法派出')
    claude.sessions[0].ctx.emit({
      type: 'turn_completed',
      turnId: host.open(parent.id).turnId!,
      outcome: 'failed',
      error: '连接断开',
    })
    await failure
    expect(child.closed).toBe(true)
    expect(host.open(parent.id).runs.agents[0].state).toBe('stopped')
  })

  it('删除主会话同时删除受管子任务的存储，不留下隐藏会话', async () => {
    const { host, parent, pixel, root, opts } = await setup()
    const result = host.delegate(parent.id, task)
    const failure = expect(result).rejects.toThrow('已停止')
    await waitFor(() => pixel.sessions.length === 1)
    await host.deleteSession(parent.id)
    await failure
    expect(host.sessions()).toHaveLength(0)
    await host.shutdown()
    const restored = new EngineHost({ ...opts, dataDir: join(root, 'data') })
    hosts.push(restored)
    expect(restored.sessions()).toHaveLength(0)
    expect(restored.memoryStats().runtimes).toBe(0)
  })

  it('Claude 接入受管代理时保留禁用提问设置，并禁用原生代理入口', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pixelsky-managed-claude-'))
    roots.push(root)
    const log = join(root, 'argv.jsonl')
    const adapter = new ClaudeAdapter({
      launcher: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))],
      },
      projectsDir: join(root, 'claude-projects'),
      env: { ...process.env, FAKE_CLAUDE_LOG: log },
      launchOptions: () => ({ outputStyle: null, askQuestions: false, args: [], autoCompactPct: null }),
    })
    const host = new EngineHost({
      dataDir: join(root, 'host'),
      emit() {},
      adapters: { claude: adapter },
      extensions: () => ({
        key: 'managed',
        pluginDirs: [],
        pathDirs: [],
        env: { PIXELSKY_MANAGED_SUBAGENTS: '1', MCP_TOOL_TIMEOUT: '1860000' },
      }),
    })
    hosts.push(host)
    const project = host.addProject(root)
    const record = host.createSession({ projectId: project.id })
    await host.send(record.id, 'hello')
    await waitFor(
      () =>
        host.open(record.id).record.lastOutcome !== null ||
        host.open(record.id).items.some(i => i.kind === 'assistant'),
    )
    const args = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]) as string[]
    expect(args.filter(a => a === '--disallowedTools')).toHaveLength(1)
    expect(args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--disallowedTools') + 4)).toEqual([
      'Agent',
      'Task',
      'AskUserQuestion',
    ])
  })
})
