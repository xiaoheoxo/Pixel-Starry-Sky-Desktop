import { describe, expect, it } from 'vitest'
import type { TerminalRecord } from '../../../../shared/types/terminal'
import type { PromptMarks } from './marks'
import {
  DONE_SHOW_MS,
  endRun,
  lastLines,
  pillsOf,
  reportsEnds,
  shortName,
  startRun,
  tabMarkOf,
  unseenAfterPrompt,
  unseenEnd,
  type TerminalRun,
} from './pills'

const marks = (over: Partial<PromptMarks> = {}): PromptMarks => ({
  generation: 1,
  prompts: 1,
  ends: 0,
  weak: 0,
  codes: [],
  ...over,
})
const record = (over: Partial<TerminalRecord> = {}): TerminalRecord => ({
  id: 't',
  projectId: 'p',
  projectName: 'p',
  cwd: '/p',
  profileId: 'x',
  profileLabel: 'x',
  title: 'PowerShell',
  titleEdited: false,
  status: 'running',
  generation: 1,
  createdAt: 0,
  ...over,
})
const start = (now = 0, command: string | null = 'pnpm build'): TerminalRun =>
  startRun(undefined, marks(), { generation: 1, now, command, afterSeq: 5 }) as TerminalRun
const ended = (code: number | null): PromptMarks => marks({ prompts: 2, ends: 1, codes: [code] })

describe('一条命令的开始和结束', () => {
  it('在跑的程序收到回车不算新命令，提示符回来后才算', () => {
    const run = start()
    expect(startRun(run, marks(), { generation: 1, now: 50, command: 'y', afterSeq: 9 })).toBe(run)
    const after = startRun(run, marks({ prompts: 2 }), { generation: 1, now: 50, command: 'y', afterSeq: 9 })
    expect(after).toMatchObject({ phase: 'running', at: 50, command: 'y', prompts: 2 })
  })
  it('exec 换掉 shell 不算新命令：新 shell 可能没有集成，胶囊会清不掉', () => {
    expect(startRun(undefined, marks(), { generation: 1, now: 0, command: '  exec bash', afterSeq: 1 })).toBeUndefined()
    const run = start()
    expect(startRun(run, marks({ prompts: 2 }), { generation: 1, now: 0, command: 'exec zsh -l', afterSeq: 1 })).toBe(
      run,
    )
    expect(start(0, 'executor run')).toMatchObject({ phase: 'running', command: 'executor run' })
  })
  it('失败的留下；中止、未知退出码、空回车不留', () => {
    expect(endRun(start(), ended(1), 100, false)).toMatchObject({ phase: 'done', code: 1 })
    expect(endRun(start(), ended(130), 100, false)).toBeUndefined()
    expect(endRun(start(), ended(-1073741510), 100, false)).toBeUndefined()
    expect(endRun(start(), ended(null), 100, false)).toBeUndefined()
    expect(endRun(start(), marks({ prompts: 2 }), 100, false)).toBeUndefined()
  })
  it('成功的只有跑得够久才留', () => {
    expect(endRun(start(), ended(0), 9_999, false)).toBeUndefined()
    expect(endRun(start(), ended(0), 10_000, false)).toMatchObject({ phase: 'done', code: 0 })
  })
  it('结束时正看着这个终端就不留', () => {
    expect(endRun(start(), ended(1), 100, true)).toBeUndefined()
  })
  it('命令比第一个提示符先写入：这个提示符不算结束', () => {
    const early = startRun(undefined, undefined, { generation: 1, now: 0, command: 'pnpm dev', afterSeq: 1 })
    const waiting = endRun(early, marks({ prompts: 1 }), 100, false)
    expect(waiting).toMatchObject({ phase: 'running', prompts: 1, at: 0, command: 'pnpm dev' })
    // 命令真的结束时照常判断
    expect(endRun(waiting, ended(1), 200, false)).toMatchObject({ phase: 'done', code: 1 })
    // 已经有过提示符的终端不受影响：空回车还是清掉
    expect(endRun(start(), marks({ prompts: 2 }), 100, false)).toBeUndefined()
  })
  it('提示符没变、换了一轮 shell', () => {
    const run = start()
    expect(endRun(run, marks(), 100, false)).toBe(run)
    expect(endRun(run, marks({ generation: 2, prompts: 5 }), 100, false)).toBeUndefined()
  })
})

describe('该显示哪些胶囊', () => {
  const show = (run: TerminalRun, now: number, m = marks(), r = record()) => pillsOf([r], { t: m }, { t: run }, now)

  it('回车后 2 秒才显示，并告诉界面什么时候再算', () => {
    expect(show(start(), 1999)).toEqual({ pills: [], nextAt: 2000 })
    expect(show(start(), 2000).pills[0]).toMatchObject({ state: 'running', name: 'pnpm build', short: 'build' })
  })
  it('失败一直留着，✓ 到期消失', () => {
    const failed: TerminalRun = { phase: 'done', generation: 1, code: 2, endedAt: 0, command: 'x', afterSeq: 0 }
    expect(show(failed, 1e9).pills[0]).toMatchObject({ state: 'failed', code: 2 })
    const ok: TerminalRun = { ...failed, code: 0 }
    expect(show(ok, DONE_SHOW_MS - 1)).toMatchObject({ nextAt: DONE_SHOW_MS })
    expect(show(ok, DONE_SHOW_MS).pills).toEqual([])
  })
  it('没有集成、cmd、旧一轮 shell 都不显示', () => {
    expect(pillsOf([record()], {}, { t: start() }, 5000).pills).toEqual([])
    expect(show(start(), 5000, marks({ weak: 1 })).pills).toEqual([])
    expect(show(start(), 5000, marks({ prompts: 0 })).pills).toEqual([])
    expect(show(start(), 5000, marks(), record({ generation: 2 })).pills).toEqual([])
  })
  it('shell 退出：非 0 算失败，否则不显示', () => {
    expect(show(start(), 5000, marks(), record({ status: 'exited', exitCode: 3 })).pills[0]).toMatchObject({
      state: 'failed',
      code: 3,
    })
    expect(show(start(), 5000, marks(), record({ status: 'exited', exitCode: 0 })).pills).toEqual([])
  })
  it('从这里移除卡住的胶囊：提示符回来前再回车也不显示，回来后照常', () => {
    const hidden = { t: { generation: 1, prompts: 1 } }
    // 移除后 runs 里没有了，再回车记下的新运行
    const again = startRun(undefined, marks(), { generation: 1, now: 0, command: 'ls', afterSeq: 9 }) as TerminalRun
    expect(pillsOf([record()], { t: marks() }, { t: again }, 5000, hidden).pills).toEqual([])
    const back = marks({ prompts: 2 })
    const next = startRun(undefined, back, { generation: 1, now: 0, command: 'ls', afterSeq: 9 }) as TerminalRun
    expect(pillsOf([record()], { t: back }, { t: next }, 5000, hidden).pills[0]).toMatchObject({ state: 'running' })
    // 重启过的 shell 不受影响
    expect(
      pillsOf(
        [record({ generation: 2 })],
        { t: marks({ generation: 2 }) },
        { t: { ...again, generation: 2 } },
        5000,
        hidden,
      ).pills,
    ).toHaveLength(1)
  })
  it('没读到命令用终端标题；失败排最前', () => {
    expect(show(start(0, null), 5000).pills[0]).toMatchObject({ name: 'PowerShell', short: 'PowerShell' })
    expect(show(start(0, null), 5000, marks(), record({ title: 'Windows PowerShell' })).pills[0].short).toBe(
      'Windows PowerShell',
    )
    const failed: TerminalRun = { phase: 'done', generation: 1, code: 1, endedAt: 0, command: 'b', afterSeq: 0 }
    const { pills } = pillsOf(
      [record({ id: 'a' }), record({ id: 'b' })],
      { a: marks(), b: marks() },
      { a: start(), b: failed },
      5000,
    )
    expect(pills.map(p => p.id)).toEqual(['b', 'a'])
  })
})

describe('显示用的文字', () => {
  it('短名字', () => {
    expect(shortName('pnpm build')).toBe('build')
    expect(shortName('npm.cmd run dev')).toBe('dev')
    expect(shortName('vitest --watch')).toBe('vitest')
    expect(shortName('./scripts/a.sh --x')).toBe('a.sh')
    expect(shortName('node --inspect server.js')).toBe('server.js')
    expect(shortName('node -e "console.log(1)"')).toBe('node')
  })
  it('最后几行：进度行只留最后一段，去掉末尾空行', () => {
    expect(lastLines('a\nb\r10%\r100%\nc\n\n', 2)).toEqual(['100%', 'c'])
    expect(lastLines('', 3)).toEqual([])
    expect(lastLines('boom\nPS C:\\proj> ', 3)).toEqual(['boom'])
    expect(lastLines('PS C:\\proj>', 3)).toEqual([])
  })
})

describe('标签上的标记（docs/ui/terminal-toolbar-status.md §3）', () => {
  it('不在眼前时命令结束：记下退出码；Ctrl+C 中止的、没有命令结束的提示符不记', () => {
    expect(unseenEnd(marks(), ended(1))).toEqual({ generation: 1, code: 1 })
    expect(unseenEnd(marks(), ended(0))).toEqual({ generation: 1, code: 0 })
    expect(unseenEnd(marks(), ended(null))).toEqual({ generation: 1, code: null })
    expect(unseenEnd(marks(), ended(130))).toBeUndefined()
    expect(unseenEnd(marks(), ended(-1073741510))).toBeUndefined()
    // 清屏重画、第一个提示符：ends 没变
    expect(unseenEnd(marks(), marks({ prompts: 2 }))).toBeUndefined()
    // 上一轮 shell 结束过 3 次，重启后的第一次结束也算
    expect(unseenEnd(marks({ ends: 3 }), marks({ generation: 2, prompts: 2, ends: 1, codes: [2] }))).toEqual({
      generation: 2,
      code: 2,
    })
    expect(unseenEnd(undefined, ended(1))).toEqual({ generation: 1, code: 1 })
  })
  it('cmd 和没有集成的 Shell 不报告命令结束', () => {
    expect(reportsEnds(marks(), 1)).toBe(true)
    expect(reportsEnds(marks({ weak: 1 }), 1)).toBe(false)
    expect(reportsEnds(undefined, 1)).toBe(false)
    expect(reportsEnds(marks(), 2)).toBe(false)
  })
  it('一个标签只有一个标记：已退出 > 在跑 > 失败 > 有新结果 > 空闲', () => {
    const failed = { generation: 1, code: 1 }
    expect(tabMarkOf(record({ status: 'exited' }), true, failed)).toBe('exited')
    expect(tabMarkOf(record({ status: 'stopped' }), false, undefined)).toBe('exited')
    expect(tabMarkOf(record({ status: 'starting' }), false, undefined)).toBe('idle')
    expect(tabMarkOf(record(), true, failed)).toBe('running')
    expect(tabMarkOf(record(), false, failed)).toBe('failed')
    expect(tabMarkOf(record(), false, { generation: 1, code: 0 })).toBe('new')
    expect(tabMarkOf(record(), false, { generation: 1, code: null })).toBe('new')
    expect(tabMarkOf(record(), false, undefined)).toBe('idle')
    // 重启后上一轮的结果不算
    expect(tabMarkOf(record({ generation: 2 }), false, failed)).toBe('idle')
  })
})

describe('提示符来了之后没看过的结果', () => {
  const failed = { generation: 1, code: 1 }
  it('没看过的失败不被后面成功的命令盖掉；后面又失败了换成新的退出码', () => {
    const after = marks({ prompts: 3, ends: 2, codes: [1, 0] })
    expect(unseenAfterPrompt(failed, ended(1), after, false)).toBe(failed)
    const again = marks({ prompts: 3, ends: 2, codes: [1, 5] })
    expect(unseenAfterPrompt(failed, ended(1), again, false)).toEqual({ generation: 1, code: 5 })
    // 上一轮 shell 的失败不挡新一轮的结果
    expect(
      unseenAfterPrompt(failed, undefined, marks({ generation: 2, prompts: 2, ends: 1, codes: [0] }), false),
    ).toEqual({
      generation: 2,
      code: 0,
    })
  })
  it('有集成的 Shell 重启后第一个提示符之前的「有新输出」去掉；cmd 的留着', () => {
    const guess = { generation: 2, code: null }
    expect(unseenAfterPrompt(guess, undefined, marks({ generation: 2, prompts: 1 }), false)).toBeUndefined()
    expect(unseenAfterPrompt(guess, undefined, marks({ generation: 2, prompts: 1, weak: 1 }), false)).toBe(guess)
  })
  it('正显示着不记新的', () => {
    expect(unseenAfterPrompt(undefined, marks(), ended(1), true)).toBeUndefined()
  })
})
