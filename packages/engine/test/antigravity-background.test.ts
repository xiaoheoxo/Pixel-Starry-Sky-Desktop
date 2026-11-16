// Antigravity 后台命令追踪（docs/antigravity-engine.md §17）：找不到子进程时的收尾
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EngineEvent } from '@pixelsky/protocol'
import { AgyBackgroundTracker, type AgyProcessOps } from '../src/antigravity/background'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(log: string) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bg-'))
  dirs.push(dir)
  const logPath = join(dir, 'task-1.log')
  writeFileSync(logPath, log)
  const events: EngineEvent[] = []
  // 回归（审查）：找子进程一直失败（PowerShell 超时等）
  const ops: AgyProcessOps = { findChild: async () => null, isAlive: () => true, killTree: async () => {} }
  const tracker = new AgyBackgroundTracker(
    e => events.push(e),
    () => 100,
    ops,
    60_000,
  )
  tracker.register({
    taskId: 's/task-1',
    logPath,
    callId: 'c1',
    command: 'npm run build',
    item: {
      kind: 'command',
      id: 'i1',
      command: 'npm run build',
      description: null,
      output: '',
      exitCode: null,
      status: 'running',
      background: true,
    },
  })
  const tasksNow = () => [...events].reverse().find(e => e.type === 'tasks') as Extract<EngineEvent, { type: 'tasks' }>
  // 登记时立即找一次子进程：等它回来（实际巡检隔 1.5 秒，早就回来了）
  const ready = new Promise(r => setTimeout(r, 0))
  return { tracker, tasksNow, ready }
}

describe('AgyBackgroundTracker：找不到子进程', () => {
  it('日志不再增长：连续 3 轮才按完成收尾，一轮没找到不算', async () => {
    const { tracker, tasksNow, ready } = setup('compiling...\n')
    await ready
    await tracker.poll()
    await tracker.poll()
    expect(tasksNow().tasks).toHaveLength(1)
    await tracker.poll()
    expect(tasksNow().tasks).toHaveLength(0)
  })

  it('日志里出现过本机地址（开发服务）：找不到进程也不当它结束了', async () => {
    const { tracker, tasksNow, ready } = setup('  VITE v7 ready\n  ➜  Local:   http://localhost:5173/\n')
    await ready
    for (let i = 0; i < 5; i++) await tracker.poll()
    expect(tasksNow().tasks).toHaveLength(1)
    tracker.processGone(false)
  })
})

describe('AgyBackgroundTracker：停止', () => {
  it('回归（审查）：找不到进程时报错、任务留着，不写「已停止」', async () => {
    const { tracker, tasksNow, ready } = setup('compiling...\n')
    await ready
    await expect(tracker.stop('s/task-1')).rejects.toThrow('没能停止')
    expect(tasksNow().tasks).toHaveLength(1)
    tracker.processGone(false)
  })
})
