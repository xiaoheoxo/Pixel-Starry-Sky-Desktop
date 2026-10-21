// 任务面板的运行状态机（提示符标记）：写命令之前的提示符不算、Ctrl+C 之后提示符回来算结束、
// 点停止先「正在停止」、提示符回来才「已停止」、正在停止时不再往这个终端写新命令
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalRecord } from '../../../../../shared/types/terminal'
import type { RunTask, RunTaskGroup } from '../../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { applyPrompt, type PromptEvent } from '@/features/terminal/marks'

const fake = vi.hoisted(() => ({
  terminals: [] as unknown[],
  marks: {} as Record<string, unknown>,
  profiles: [] as unknown[],
}))
vi.mock('@/data', () => ({ isDemo: false }))
vi.mock('@/data/demo', () => ({ demo: () => ({}) }))
vi.mock('@/features/extpacks/store', () => ({ subscribePacks: () => () => {} }))
vi.mock('@/features/files/store', () => ({ FILE_SAVED_EVENT: 'pixelsky:file-saved' }))
vi.mock('./extTemplates', () => ({ activeTaskTemplates: () => [], extTaskFileNames: () => new Set<string>() }))
vi.mock('@/features/terminal/TerminalProvider', () => ({ useTerminalUi: () => ({}) }))
vi.mock('@/features/terminal/store', () => ({
  terminalState: () => fake,
  useTerminalStore: () => fake,
}))

const written: { id: string; data: string }[] = []
vi.stubGlobal('window', {
  addEventListener: () => {},
  pixelsky: {
    terminal: {
      write: (id: string, _generation: number, data: string) => {
        written.push({ id, data })
        return Promise.resolve()
      },
    },
  },
})

const { getRunTasks, getTaskStatus, loadTasks, runFailureText, runTaskIn, stopTaskIn, STOPPING_TIMEOUT_MS } =
  await import('./store')

// 任务 → 终端的对应存在模块里，每个用例换一个工作区根，互不影响
let ROOT = 'D:/proj'
let counter = 0
const group: RunTaskGroup = {
  kind: 'npm',
  file: 'package.json',
  dir: '',
  manager: 'pnpm',
  tasks: [{ name: 'dev', detail: 'vite', line: 1 } as RunTask],
}
const task = group.tasks[0]

const record = (id: string, status: TerminalRecord['status'] = 'running'): TerminalRecord => ({
  id,
  projectId: 'p',
  projectName: 'p',
  cwd: ROOT,
  profileId: 'pwsh',
  profileLabel: 'PowerShell 7',
  title: id,
  titleEdited: false,
  status,
  generation: 1,
  createdAt: 0,
})
/** 终端发来的提示符事件（和 main 的 prompt 事件一样） */
function prompt(id: string, ran: boolean | null, exitCode: number | null = null, generation = 1): void {
  const event: PromptEvent = { type: 'prompt', terminalId: id, generation, ran, exitCode }
  fake.marks = { ...fake.marks, [id]: applyPrompt(fake.marks[id] as never, event) }
}
const status = (t: RunTask = task): string => getTaskStatus(ROOT, group, t).kind

/** 模拟 TerminalProvider.runTask：复用 / 新建终端，记下写入的命令；命令真正写入（onSent）由测试用 sent() 触发 */
function makeHost() {
  const commands: { id: string; reuse: string | null; command: string }[] = []
  let pending: (() => void) | null = null
  let seq = 0
  const select = vi.fn()
  const runTask = vi.fn(
    async (
      _name: string,
      command: string | ((program: string | undefined) => string),
      reuse?: string | null,
      onSent?: (id: string) => void,
    ) => {
      const id = reuse ?? `t${++seq}`
      if (!fake.terminals.some(r => (r as TerminalRecord).id === id)) fake.terminals = [...fake.terminals, record(id)]
      commands.push({
        id,
        reuse: reuse ?? null,
        command: typeof command === 'function' ? command('pwsh.exe') : command,
      })
      pending = () => onSent?.(id)
      return id
    },
  )
  return { host: { runTask, select }, commands, select, runTask, sent: () => pending?.() }
}

beforeEach(() => {
  ROOT = `D:/proj${++counter}`
  fake.terminals = []
  fake.marks = {}
  written.length = 0
})

describe('任务运行状态机', () => {
  it('写命令之前的提示符不算结束：命令写入后，要等下一次「命令结束」', async () => {
    const h = makeHost()
    // 终端先出了第一个提示符，又有过一条命令结束（比如用户自己跑过 ls）
    fake.terminals = [record('t1')]
    prompt('t1', false)
    prompt('t1', true, 0)
    await runTaskIn(h.host, ROOT, group, task, false, '')
    expect(status()).toBe('running')
    // 命令写入前飞在路上的提示符
    prompt('t1', true, 0)
    h.sent()
    expect(status()).toBe('running')
    // 写入之后，没跑过命令的提示符（清屏重画）也不算
    prompt('t1', false)
    expect(status()).toBe('running')
    // 写入之后的命令结束才算
    prompt('t1', true, 0)
    expect(status()).toBe('ok')
  })

  it('命令还没写进终端（base 未记）时，什么标记都不算结束', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    prompt('t1', false)
    prompt('t1', true, 0)
    expect(status()).toBe('running')
    h.sent()
    expect(status()).toBe('running')
  })

  it('命令写入先于 runTask 返回，也能接上', async () => {
    const h = makeHost()
    h.runTask.mockImplementationOnce(async (_n, _c, _r, onSent) => {
      fake.terminals = [record('t1')]
      onSent?.('t1')
      return 't1'
    })
    await runTaskIn(h.host, ROOT, group, task)
    prompt('t1', true, 1)
    expect(getTaskStatus(ROOT, group, task)).toEqual({ kind: 'failed', code: 1 })
  })

  it('Ctrl+C 中止整行后提示符回来：按退出码判断；被 Ctrl+C 打断的算已停止，不标失败', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', false)
    expect(status()).toBe('running')
    prompt('t1', true, -1073741510)
    expect(getTaskStatus(ROOT, group, task)).toEqual({ kind: 'stopped', code: null })
  })

  it('退出码非 0 且不是打断：失败，带退出码', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', true, 2)
    expect(getTaskStatus(ROOT, group, task)).toEqual({ kind: 'failed', code: 2 })
  })

  it('cmd（ran=null）的提示符不算命令结束：echo on 的 .bat 每行回显都有一个，任务还在跑', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', null)
    prompt('t1', null)
    prompt('t1', null)
    expect(status()).toBe('running')
  })

  it('shell 退出了（exit 后缀）仍按退出码判断，不受标记影响', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    fake.terminals = [{ ...record('t1', 'exited'), exitCode: 3 }]
    expect(getTaskStatus(ROOT, group, task)).toEqual({ kind: 'failed', code: 3 })
  })

  it('结束之后用户又在终端里跑别的命令，任务状态不变', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', true, 1)
    prompt('t1', true, 0)
    expect(getTaskStatus(ROOT, group, task)).toEqual({ kind: 'failed', code: 1 })
  })
})

describe('停止', () => {
  it('有提示符标记：先「正在停止」并发 Ctrl+C，提示符回来才「已停止」', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', false)
    stopTaskIn(ROOT, group, task)
    expect(written).toEqual([{ id: 't1', data: '\x03' }])
    expect(status()).toBe('stopping')
    // 程序还没停（比如 gradlew.bat 在问「终止批处理操作吗(Y/N)?」）：一直是正在停止
    expect(status()).toBe('stopping')
    prompt('t1', true, 1)
    expect(getTaskStatus(ROOT, group, task)).toEqual({ kind: 'stopped', code: null })
  })

  it('没有提示符标记的 shell：像以前一样直接「已停止」', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    stopTaskIn(ROOT, group, task)
    expect(written).toEqual([{ id: 't1', data: '\x03' }])
    expect(status()).toBe('stopped')
  })

  it('正在停止时再点运行：不往终端写新命令，只跳到它的终端', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', false)
    stopTaskIn(ROOT, group, task)
    await runTaskIn(h.host, ROOT, group, task)
    expect(h.runTask).toHaveBeenCalledTimes(1)
    expect(h.select).toHaveBeenCalledWith('t1')
    expect(status()).toBe('stopping')
  })

  it('正在停止时再点停止：再发一次 Ctrl+C', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', false)
    stopTaskIn(ROOT, group, task)
    stopTaskIn(ROOT, group, task)
    expect(written.map(w => w.data)).toEqual(['\x03', '\x03'])
    expect(status()).toBe('stopping')
  })

  it('正在停止时「在新终端里运行」不受影响', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', false)
    stopTaskIn(ROOT, group, task)
    await runTaskIn(h.host, ROOT, group, task, true)
    expect(h.runTask).toHaveBeenCalledTimes(2)
    expect(h.commands[1].reuse).toBeNull()
  })

  it('已停止之后再点运行：复用这个终端写新命令，从头算', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', false)
    stopTaskIn(ROOT, group, task)
    prompt('t1', true, 130)
    expect(status()).toBe('stopped')
    await runTaskIn(h.host, ROOT, group, task)
    expect(h.runTask).toHaveBeenCalledTimes(2)
    expect(h.commands[1].reuse).toBe('t1')
    h.sent()
    expect(status()).toBe('running')
    prompt('t1', true, 0)
    expect(status()).toBe('ok')
  })
})

describe('终端重启', () => {
  it('重启后复用终端：新 shell 的第一个提示符还没到就写入命令，结束照样认', async () => {
    const h = makeHost()
    fake.terminals = [record('t1')]
    prompt('t1', false)
    prompt('t1', true, 0) // 上一轮 shell 里跑过一条命令：ends = 1
    // 终端退出后重启：generation 变成 2，新 shell 还没出过提示符，记录里还是上一轮的
    fake.terminals = [{ ...record('t1'), generation: 2 }]
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    expect(status()).toBe('running')
    prompt('t1', false, null, 2)
    expect(status()).toBe('running')
    // Ctrl+C 中止整行：新一轮的第一次结束（ends = 1，不能被旧的 base = 1 吃掉）
    prompt('t1', true, 130, 2)
    expect(getTaskStatus(ROOT, group, task)).toEqual({ kind: 'stopped', code: null })
  })

  it('重启后复用终端，点停止也能收尾，不会永远卡「正在停止」', async () => {
    const h = makeHost()
    fake.terminals = [record('t1')]
    prompt('t1', false)
    prompt('t1', true, 0)
    fake.terminals = [{ ...record('t1'), generation: 2 }]
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', false, null, 2)
    stopTaskIn(ROOT, group, task)
    expect(status()).toBe('stopping')
    prompt('t1', true, 1, 2)
    expect(status()).toBe('stopped')
  })

  it('手动重启终端（Run 还在）：这次运行随旧 shell 结束，任务回到平时的样子', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', false)
    expect(status()).toBe('running')
    fake.terminals = [{ ...record('t1'), generation: 2 }]
    expect(status()).toBe('idle')
    // 新 shell 里的提示符不会让它冒出结束状态
    prompt('t1', false, null, 2)
    prompt('t1', true, 0, 2)
    expect(status()).toBe('idle')
  })
})

describe('cmd 和停止的兜底', () => {
  it('cmd：点停止后再出现提示符，「正在停止」收成「已停止」（echo on 的回显提示符发生在点停止之前不算）', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', null)
    prompt('t1', null)
    stopTaskIn(ROOT, group, task)
    expect(status()).toBe('stopping')
    prompt('t1', null)
    expect(getTaskStatus(ROOT, group, task)).toEqual({ kind: 'stopped', code: null })
  })

  describe('正在停止的超时兜底', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('一直收不到提示符（prompt 被用户换掉了）：超时后退回旧行为显示「已停止」', async () => {
      const h = makeHost()
      await runTaskIn(h.host, ROOT, group, task)
      h.sent()
      prompt('t1', false)
      stopTaskIn(ROOT, group, task)
      vi.advanceTimersByTime(STOPPING_TIMEOUT_MS - 1)
      expect(status()).toBe('stopping')
      vi.advanceTimersByTime(1)
      expect(status()).toBe('stopped')
    })

    it('再点一次停止会重新计时；超时前提示符回来或重新运行，旧的计时不误伤新的运行', async () => {
      const h = makeHost()
      await runTaskIn(h.host, ROOT, group, task)
      h.sent()
      prompt('t1', false)
      stopTaskIn(ROOT, group, task)
      vi.advanceTimersByTime(STOPPING_TIMEOUT_MS - 1000)
      stopTaskIn(ROOT, group, task)
      vi.advanceTimersByTime(STOPPING_TIMEOUT_MS - 1000)
      expect(status()).toBe('stopping')
      vi.advanceTimersByTime(1000)
      expect(status()).toBe('stopped')

      // 重新运行后，旧运行遗留的计时不会把新运行标成已停止
      await runTaskIn(h.host, ROOT, group, task)
      h.sent()
      stopTaskIn(ROOT, group, task)
      prompt('t1', true, 130)
      expect(status()).toBe('stopped')
      await runTaskIn(h.host, ROOT, group, task)
      h.sent()
      vi.advanceTimersByTime(STOPPING_TIMEOUT_MS * 2)
      expect(status()).toBe('running')
    })
  })
})

describe('标记判定过的结果不被之后的退出改判', () => {
  it('提示符回来判了结束，用户又在终端里 exit 5：结果不变', async () => {
    const h = makeHost()
    await runTaskIn(h.host, ROOT, group, task)
    h.sent()
    prompt('t1', true, 0)
    expect(status()).toBe('ok')
    fake.terminals = [{ ...record('t1', 'exited'), exitCode: 5 }]
    expect(getTaskStatus(ROOT, group, task)).toEqual({ kind: 'ok', code: null })
  })
})

describe('cmd 下含 % 的路径', () => {
  it('命令拼不出来：错误交给调用方，不记运行，任务保持空闲', async () => {
    const { TaskCommandError } = await import('./extCommand')
    const bad: RunTaskGroup = { ...group, dir: '100%', file: '100%/package.json' }
    const runTask = vi.fn(async (_name: string, command: string | ((program: string | undefined) => string)) => {
      if (typeof command === 'function') command('cmd.exe')
      return 't1'
    })
    await expect(runTaskIn({ runTask, select: vi.fn() }, ROOT, bad, task)).rejects.toBeInstanceOf(TaskCommandError)
    expect(getTaskStatus(ROOT, bad, task).kind).toBe('idle')
  })
})

describe('运行失败的提示', () => {
  it('命令拼不出来用对应文案；其它错误（建终端失败等）带上原因，不再往外抛', async () => {
    const { TaskCommandError } = await import('./extCommand')
    expect(runFailureText(new TaskCommandError('100%'))).toContain('%')
    expect(runFailureText(new Error('ENOENT pwsh.exe'))).toBe('运行失败：ENOENT pwsh.exe')
    expect(runFailureText('boom')).toContain('boom')
  })
})

describe('读任务', () => {
  const state = (root: string) => ({ root, groups: [], truncated: false })
  let pending: Array<(value: unknown) => void> = []
  beforeEach(() => {
    pending = []
    ;(window.pixelsky as unknown as Record<string, unknown>).projectTools = {
      runTasks: () => new Promise(resolve => pending.push(resolve)),
    }
  })

  it('正在读时又要求重读：读完补读一次，最后是新读到的', async () => {
    const ref = { projectId: `reread${counter}` } as WorkspaceRef
    const first = loadTasks(ref)
    void loadTasks(ref)
    expect(pending).toHaveLength(1)
    pending[0](state('old'))
    await first
    expect(pending).toHaveLength(2)
    pending[1](state('new'))
    await vi.waitFor(() => expect(getRunTasks(ref).state?.root).toBe('new'))
    expect(getRunTasks(ref).loading).toBe(false)
    expect(pending).toHaveLength(2)
  })

  it('读失败了也补读；只要「maxAge 内读过就行」的不补读', async () => {
    const ref = { projectId: `reread-fail${counter}` } as WorkspaceRef
    ;(window.pixelsky as unknown as { projectTools: unknown }).projectTools = {
      runTasks: () =>
        new Promise((resolve, reject) => pending.push(pending.length === 0 ? () => reject(new Error('x')) : resolve)),
    }
    const first = loadTasks(ref)
    void loadTasks(ref)
    pending[0](null)
    await first
    expect(pending).toHaveLength(2)
    pending[1](state('ok'))
    await vi.waitFor(() => expect(getRunTasks(ref).state?.root).toBe('ok'))

    const again = loadTasks(ref)
    void loadTasks(ref, 60_000)
    pending[2](state('ok2'))
    await again
    expect(pending).toHaveLength(3)
  })
})
