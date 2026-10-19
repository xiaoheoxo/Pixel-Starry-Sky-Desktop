// /resume 在斜杠菜单里出现的条件：执行者是 Claude Code 或 Codex，且不在远程机器上
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import { resumeAvailable } from './useResumeCommand'

describe('resumeAvailable', () => {
  it('Claude Code 和 Codex 都有 /resume，别的执行者没有', () => {
    expect(resumeAvailable('claude', 'p1')).toBe(true)
    expect(resumeAvailable('codex', 'p1')).toBe(true)
    expect(resumeAvailable('pixel', 'p1')).toBe(false)
    expect(resumeAvailable(null, 'p1')).toBe(false)
    expect(resumeAvailable(undefined, 'p1')).toBe(false)
  })
  it('远程机器 / WSL 上两个引擎都没有', () => {
    expect(resumeAvailable('codex', 'ssh-abc123~p')).toBe(false)
    expect(resumeAvailable('claude', 'wsl-abc123~p')).toBe(false)
  })
})
