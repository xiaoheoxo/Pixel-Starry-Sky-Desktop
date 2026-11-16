// agy acp 翻译：喂 P0 录下来的真实 session/update（docs/antigravity-engine.md §7），看出来的条目对不对
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { EngineEvent, Item } from '@pixelsky/protocol'
import {
  collectDescendants,
  logProgressMessage,
  parseAgyBackgroundTask,
  pickCommandChild,
  readLogTail,
} from '../src/antigravity/background'
import { AgyTranslator, agyPath, agyTurnUsage, commandOutput } from '../src/antigravity/translate'

const CWD = 'D:\\PixelSky\\scratch\\2026-11-14-agy-acp\\work-allow'
type Line = { dir: string; msg: Record<string, any> }
const lines = (name: string): Line[] =>
  readFileSync(join(__dirname, `antigravity-${name}.ndjson`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Line)

/** 按录像喂：session/update 走 update，权限请求走 approval；返回最后每个条目的样子 */
function replay(name: string, cwd = CWD): { items: Map<string, Item>; events: EngineEvent[]; t: AgyTranslator } {
  const events: EngineEvent[] = []
  const t = new AgyTranslator(e => events.push(e), cwd)
  for (const { dir, msg } of lines(name)) {
    if (dir !== 'in') continue
    if (msg.method === 'session/update') t.update(msg.params.update)
    if (msg.method === 'session/request_permission')
      events.push({ type: 'approval_request', request: t.approval('r' + msg.id, msg.params) })
  }
  t.finish('completed')
  const items = new Map<string, Item>()
  for (const e of events) {
    if (e.type === 'item_started' || e.type === 'item_completed') items.set(e.item.id, e.item)
    if (e.type === 'item_delta') {
      const it = items.get(e.itemId) as { text: string }
      it.text += e.delta
    }
  }
  return { items, events, t }
}

describe('agy 翻译（录像）', () => {
  it('全部允许：新建、修改、读文件，最后的回复', () => {
    const { items, events } = replay('allow')
    const list = [...items.values()]
    const changes = list.filter(i => i.kind === 'file_change')
    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({
      status: 'completed',
      changes: [{ path: 'note.txt', kind: 'add', added: 1, removed: 0 }],
    })
    expect(changes[1]).toMatchObject({ changes: [{ path: 'note.txt', kind: 'update', added: 1, removed: 1 }] })
    expect(list.find(i => i.kind === 'tool')).toMatchObject({
      tool: 'read',
      name: 'read_file',
      title: 'note.txt',
      status: 'completed',
    })
    const reply = list.find(i => i.kind === 'assistant') as { text: string }
    expect(reply.text).toContain('second')
    const approvals = events.filter(e => e.type === 'approval_request')
    expect(approvals).toHaveLength(2)
    expect(approvals[0]).toMatchObject({
      request: { kind: 'file_change', alwaysScopes: ['session'], canAllowAll: false },
    })
  })

  it('命令：去掉输出抬头，带退出码；拒绝写文件后工具失败', () => {
    const { items } = replay('tools', 'D:\\PixelSky\\scratch\\2026-11-14-agy-acp\\work')
    const list = [...items.values()]
    expect(list.find(i => i.kind === 'command')).toMatchObject({
      command: 'echo hello-acp',
      description: 'Run echo hello-acp',
      output: 'hello-acp',
      exitCode: 0,
      status: 'completed',
    })
    expect(list.find(i => i.kind === 'file_change')).toMatchObject({ status: 'failed' })
  })

  it('错误前缀的回复不当回复，记成错误', () => {
    const events: EngineEvent[] = []
    const t = new AgyTranslator(e => events.push(e), CWD)
    t.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '\n⚠ agent executor error: Error 404, Message: Model "x" is not supported\n' },
    })
    expect(events).toHaveLength(0)
    expect(t.error).toContain('Error 404')
  })

  it('思考和回复分成两条，计划成待办，命令列表和模式交给会话', () => {
    const events: EngineEvent[] = []
    const t = new AgyTranslator(e => events.push(e), CWD)
    t.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一下' } })
    t.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } })
    t.update({
      sessionUpdate: 'plan',
      entries: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
      ],
    })
    expect(events.filter(e => e.type === 'item_started').map(e => (e as { item: Item }).item.kind)).toEqual([
      'reasoning',
      'assistant',
      'todo',
    ])
    expect(t.update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })).toEqual({ mode: 'plan' })
    expect(
      t.update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'goal', description: 'g' }] }),
    ).toEqual({ commands: [{ name: 'goal', description: 'g', source: 'engine' }] })
  })

  it('路径、命令输出、用量', () => {
    expect(agyPath('/D:/a/b.txt')).toBe('D:\\a\\b.txt')
    expect(agyPath('D:/a/b.txt')).toBe('D:\\a\\b.txt')
    expect(commandOutput('Created At: x\nCommand exited with code 0.\n\nCommand output:\nhi\r\n')).toBe('hi')
    expect(
      agyTurnUsage({ inputTokens: 21500, outputTokens: 248, cachedReadTokens: 24585, cachedWriteTokens: 0 }, 'm', 5)
        .models.m,
    ).toEqual({ input: 21500, output: 248, cacheRead: 24585, cacheWrite: 0, costUsd: null })
  })
})

describe('agy 任务清单和系统提示', () => {
  it('写 brain/<对话>/task.md 翻成进度卡，不算改文件', () => {
    const events: EngineEvent[] = []
    const t = new AgyTranslator(e => events.push(e), CWD)
    const path = 'C:/Users/a/.gemini/antigravity-cli/brain/9e78e0df/task.md'.replace(/\//g, '\\')
    const call = { toolCallId: 'c1', name: 'write_file', kind: 'edit', locations: [{ path }] }
    const content = '# Task List\n\n- [x] a <!-- id: 1 -->\n- [/] b <!-- id: 2 -->\n- [ ] c\n'
    t.update({ sessionUpdate: 'tool_call', ...call, status: 'in_progress', rawInput: { Content: content } })
    t.update({
      sessionUpdate: 'tool_call_update',
      ...call,
      status: 'completed',
      content: [{ type: 'diff', path: '/' + path.replace(/\\/g, '/'), newText: content.replace('[/] b', '[x] b') }],
    })
    const kinds = events.map(e => ('item' in e ? e.item.kind : e.type))
    expect(kinds).toEqual(['todo', 'todo'])
    expect((events[1] as { item: Item }).item).toMatchObject({
      steps: [
        { text: 'a', status: 'completed' },
        { text: 'b', status: 'completed' },
        { text: 'c', status: 'pending' },
      ],
    })
  })

  it('系统提示：按开关拼', async () => {
    const { agySystemPrompt } = await import('../src/antigravity/session')
    expect(agySystemPrompt({ askQuestions: true, autoPlan: false, autoCompactPct: null })).toBe('')
    const both = agySystemPrompt({ askQuestions: false, autoPlan: true, autoCompactPct: null })
    expect(both).toContain('task.md')
    expect(both).toContain('ask_question')
  })
})

describe('agy 后台命令解析与翻译', () => {
  it('识别后台任务输出、读日志尾部、保留本机端口地址、挑子进程与后代排序', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pixelsky-agy-bg-'))
    try {
      const logFile = join(tmp, 'dir with space', 'task-77.log')
      mkdirSync(join(tmp, 'dir with space'), { recursive: true })
      writeFileSync(
        logFile,
        '\x1b[32m  VITE v6.3.5\x1b[0m ready in 400 ms\r\n  ➜  Local:   http://localhost:5173/\r\n  ➜  press h + enter to show help\r\n',
      )
      const raw = `Tool is running as a background task with task id: s1/task-77\nTask logs are available at: ${pathToFileURL(logFile).href}\nYOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) ...`
      const parsed = parseAgyBackgroundTask(raw)
      expect(parsed).toEqual({ taskId: 's1/task-77', logPath: logFile })
      expect(parseAgyBackgroundTask('Command exited with code 0.\n\nCommand output:\nhi\n')).toBeNull()

      const full = readLogTail(logFile)
      expect(full.truncated).toBe(false)
      const progress = logProgressMessage(full.output)
      expect(progress).toEqual({
        message: '➜  press h + enter to show help · http://localhost:5173',
        url: 'http://localhost:5173',
      })
      // 大文件只取尾部并按整行对齐
      writeFileSync(logFile, Array.from({ length: 40 }, (_, i) => `line-${i}-padding-text`).join('\n') + '\n')
      const cut = readLogTail(logFile, 120)
      expect(cut.truncated).toBe(true)
      expect(cut.output.startsWith('line-')).toBe(true)

      // 挑子进程：跳过 conhost 和已认领 PID，匹配带引号转义的命令行
      const pid = pickCommandChild(
        [
          { pid: 10, name: 'conhost.exe', commandLine: 'conhost.exe 0x4' },
          { pid: 11, name: 'powershell.exe', commandLine: 'powershell -Command "pnpm dev"' },
          {
            pid: 12,
            name: 'powershell.exe',
            commandLine: 'powershell -Command "pnpm --filter \\"desktop\\" build"',
          },
        ],
        'pnpm --filter "desktop" build',
        new Set([11]),
      )
      expect(pid).toBe(12)
      expect(
        collectDescendants(
          [
            { pid: 20, ppid: 12 },
            { pid: 21, ppid: 20 },
            { pid: 99, ppid: 1 },
          ],
          12,
        ),
      ).toEqual([21, 20, 12])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('实时会话里转后台保持 running 且跨轮不收尾；历史回放里直接收尾并填入日志', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pixelsky-agy-bg-tr-'))
    try {
      const logFile = join(tmp, 'task-9.log')
      writeFileSync(logFile, 'built in 1.2s\n')
      const rawOut = {
        output: `Tool is running as a background task with task id: s1/task-9\nTask logs are available at: ${pathToFileURL(logFile).href}\nYOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: ...`,
      }
      const call = {
        toolCallId: 'c9',
        name: 'run_command',
        kind: 'execute',
        title: 'pnpm build',
        rawInput: { CommandLine: 'pnpm build', toolSummary: 'Package build' },
      }

      const liveEvents: EngineEvent[] = []
      const live = new AgyTranslator(e => liveEvents.push(e), CWD, true)
      live.update({ sessionUpdate: 'tool_call', ...call, status: 'in_progress' })
      const started = live.update({
        sessionUpdate: 'tool_call_update',
        ...call,
        status: 'completed',
        rawOutput: rawOut,
      })
      expect(started.backgroundStarted).toMatchObject({ taskId: 's1/task-9', logPath: logFile, command: 'pnpm build' })
      live.finish('completed')
      const lastLive = liveEvents.filter(e => 'item' in e).at(-1) as { type: string; item: Item }
      expect(lastLive.item).toMatchObject({
        kind: 'command',
        command: 'pnpm build',
        output: '',
        status: 'running',
        background: true,
      })

      const killed = live.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'k1',
        name: 'manage_task',
        kind: 'other',
        status: 'completed',
        rawInput: { Action: 'kill', TaskId: 's1/task-9' },
      })
      expect(killed.backgroundKilled).toBe('s1/task-9')

      // 回放模式（默认 liveBackground = false）：直接完成并带上日志文字，不漏出系统指令
      const replayEvents: EngineEvent[] = []
      const rep = new AgyTranslator(e => replayEvents.push(e), CWD)
      rep.update({ sessionUpdate: 'tool_call', ...call, status: 'in_progress' })
      rep.update({ sessionUpdate: 'tool_call_update', ...call, status: 'completed', rawOutput: rawOut })
      rep.finish('completed')
      const lastRep = replayEvents.filter(e => e.type === 'item_completed').at(-1) as { item: Item }
      expect(lastRep.item).toMatchObject({
        kind: 'command',
        output: 'built in 1.2s',
        status: 'completed',
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
