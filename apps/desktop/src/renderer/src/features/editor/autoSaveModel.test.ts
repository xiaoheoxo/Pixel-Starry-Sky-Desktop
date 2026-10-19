import { describe, expect, it } from 'vitest'
import { aiBusyFor, autoSaveVerdict, pathsOverlap, sanitizeAutoSave, type AutoSaveTab } from './autoSaveModel'

const tab = (over: Partial<AutoSaveTab> = {}): AutoSaveTab => ({
  id: 't1',
  ref: { projectId: 'p1' },
  root: 'D:\\code\\app',
  draft: 'new',
  document: { kind: 'text', content: 'old' },
  external: null,
  loading: false,
  saving: false,
  ...over,
})
const session = (state: string, over: { id?: string; projectId?: string; cwd?: string; background?: number } = {}) => ({
  record: { id: over.id ?? 's1', projectId: over.projectId ?? 'p2', cwd: over.cwd ?? 'D:\\other' },
  state,
  ...(over.background ? { background: over.background } : {}),
})
const verdict = (over: Partial<Parameters<typeof autoSaveVerdict>[0]> = {}) =>
  autoSaveVerdict({ tab: tab(), dirty: true, failedDraft: undefined, sessions: [], caseInsensitive: true, ...over })

describe('sanitizeAutoSave', () => {
  it('不认识的值回到默认（关闭、1 秒），延迟取整并夹在 200 ms 到 60 秒', () => {
    expect(sanitizeAutoSave(null)).toEqual({ mode: 'off', delay: 1000 })
    expect(sanitizeAutoSave({ mode: 'sometimes', delay: 'x' })).toEqual({ mode: 'off', delay: 1000 })
    expect(sanitizeAutoSave({ mode: 'afterDelay', delay: 1234.6 })).toEqual({ mode: 'afterDelay', delay: 1235 })
    expect(sanitizeAutoSave({ mode: 'onFocusChange', delay: 5 }).delay).toBe(200)
    expect(sanitizeAutoSave({ mode: 'onWindowChange', delay: 1e9 }).delay).toBe(60_000)
  })
})

describe('pathsOverlap', () => {
  it('同一个、包含、被包含都算；只是前缀相同不算；Windows 不分大小写和斜杠方向', () => {
    expect(pathsOverlap('D:\\code\\app', 'd:/code/app/', true)).toBe(true)
    expect(pathsOverlap('D:\\code\\app', 'D:\\code', true)).toBe(true)
    expect(pathsOverlap('D:\\code', 'D:\\code\\app\\src', true)).toBe(true)
    expect(pathsOverlap('D:\\code\\app', 'D:\\code\\app2', true)).toBe(false)
    expect(pathsOverlap('/home/a/App', '/home/a/app', false)).toBe(false)
    expect(pathsOverlap('', '/home', false)).toBe(false)
  })
})

describe('aiBusyFor', () => {
  it('同一个会话、同一个项目、工作目录重叠，且在跑（含后台子智能体）才算', () => {
    expect(aiBusyFor(tab(), [session('running', { projectId: 'p1' })], true)).toBe(true)
    expect(aiBusyFor(tab({ ref: { sessionId: 's1' } }), [session('waiting')], true)).toBe(true)
    expect(aiBusyFor(tab(), [session('starting', { cwd: 'd:/code/app/sub' })], true)).toBe(true)
    expect(aiBusyFor(tab(), [session('idle', { projectId: 'p1', background: 2 })], true)).toBe(true)
    expect(aiBusyFor(tab(), [session('idle', { projectId: 'p1' })], true)).toBe(false)
    expect(aiBusyFor(tab(), [session('running')], true)).toBe(false)
  })
})

describe('autoSaveVerdict', () => {
  it('有改动的文本文件：存', () => {
    expect(verdict()).toBe('save')
  })
  it('没改动、不是文本、只读、正在读 / 存、和磁盘冲突：不存', () => {
    expect(verdict({ dirty: false })).toBe('skip')
    expect(verdict({ tab: tab({ document: { kind: 'image' } }) })).toBe('skip')
    expect(verdict({ tab: tab({ document: { kind: 'text', readonly: true } }) })).toBe('skip')
    expect(verdict({ tab: tab({ loading: true }) })).toBe('skip')
    expect(verdict({ tab: tab({ saving: true }) })).toBe('skip')
    expect(verdict({ tab: tab({ external: { kind: 'text' } }) })).toBe('skip')
  })
  it('上次这份内容自动保存失败了：不再试；改过就再试', () => {
    expect(verdict({ failedDraft: 'new' })).toBe('skip')
    expect(verdict({ failedDraft: 'older' })).toBe('save')
  })
  it('AI 正在这个项目里跑：等', () => {
    expect(verdict({ sessions: [session('running', { projectId: 'p1' })] })).toBe('wait')
  })
})
