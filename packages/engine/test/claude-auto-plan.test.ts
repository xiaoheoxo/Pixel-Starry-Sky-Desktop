// 多步任务自动列计划（docs/ui/progress-card.md §10）：说明写进文件，界面模式启动时 --append-system-prompt-file 带上
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_PLAN_PROMPT, autoPlanFile } from '../src/claude/auto-plan'
import { claudeArgs } from '../src/claude/session'

const dirs: string[] = []
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'auto-plan-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('autoPlanFile', () => {
  it('开着：写好说明文件；内容过时就重写', () => {
    const d = dir()
    const file = autoPlanFile(true, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' }, d)
    expect(file).toBe(join(d, 'claude-auto-plan.md'))
    expect(readFileSync(file!, 'utf8')).toBe(AUTO_PLAN_PROMPT)
    writeFileSync(file!, '旧的')
    autoPlanFile(true, {}, d)
    expect(readFileSync(file!, 'utf8')).toBe(AUTO_PLAN_PROMPT)
  })

  it('关掉了、或用户把任务工具关了：不加', () => {
    const d = dir()
    expect(autoPlanFile(false, {}, d)).toBeNull()
    expect(autoPlanFile(true, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }, d)).toBeNull()
    expect(autoPlanFile(true, { CLAUDE_CODE_ENABLE_TODO_TOOLS: 'false' }, d)).toBeNull()
    expect(autoPlanFile(true, { CLAUDE_CODE_ENABLE_TODO_TOOLS: 'off' }, d)).toBeNull()
    expect(autoPlanFile(true, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '' }, d)).toBeNull()
    expect(autoPlanFile(true, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' }, d)).toBeNull()
    expect(
      autoPlanFile(true, { CLAUDE_CODE_ENABLE_TODO_TOOLS: 'yes', CLAUDE_CODE_ENABLE_TASKS: '1' }, d),
    ).not.toBeNull()
  })

  it('写不了文件：返回 null，照常启动', () => {
    const d = dir()
    const blocker = join(d, 'file')
    writeFileSync(blocker, '')
    // 目录位置是个文件：mkdir 失败
    expect(autoPlanFile(true, {}, join(blocker, 'sub'))).toBeNull()
  })
})

describe('claudeArgs', () => {
  const settings = { permissionMode: 'edits', model: null, effort: null } as unknown as Parameters<typeof claudeArgs>[0]
  it('有说明文件时带上 --append-system-prompt-file，没有时不带', () => {
    const on = claudeArgs(settings, 's', false, { outputStyle: null, askQuestions: true, planPromptFile: 'D:/x/p.md' })
    expect(on.slice(on.indexOf('--append-system-prompt-file'), on.indexOf('--append-system-prompt-file') + 2)).toEqual([
      '--append-system-prompt-file',
      'D:/x/p.md',
    ])
    const off = claudeArgs(settings, 's', false, { outputStyle: null, askQuestions: true, planPromptFile: null })
    expect(off).not.toContain('--append-system-prompt-file')
  })
})
