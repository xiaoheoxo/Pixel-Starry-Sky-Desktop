import { afterEach, describe, expect, it } from 'vitest'
import { setCurrentLocale } from '../../../i18n/core'
import type { GitFileChange, GitStatus } from '../../../../../shared/types/project-tools'
import { ago, diffMode, gitSections, needsCommitAll, neighbour, sameGitDiff, splitPath, syncState } from './gitModel'

afterEach(() => setCurrentLocale('zh-CN'))
const f = (path: string, code: GitFileChange['code'] = 'M'): GitFileChange => ({
  path,
  origPath: null,
  code,
  local: path,
  submodule: false,
})
const status = (patch: Partial<GitStatus>): GitStatus => ({
  repo: true,
  missing: false,
  root: 'r',
  branch: 'main',
  detached: false,
  head: 'h',
  initial: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  remotes: [],
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  truncated: false,
  operation: null,
  fetchedAt: null,
  busySessions: 0,
  ...patch,
})

describe('Git 面板显示规则', () => {
  it('分组顺序：冲突 → 暂存 → 更改 → 未跟踪，空组不显示；在分组之间切换文件', () => {
    const s = status({ conflicted: [f('c', 'U')], staged: [f('a')], untracked: [f('n', '?')] })
    const sections = gitSections(s)
    expect(sections.map(x => x.area)).toEqual(['conflicted', 'staged', 'untracked'])
    expect(neighbour(sections, 'staged', 'a', 1)?.file.path).toBe('n')
    expect(neighbour(sections, 'staged', 'a', -1)?.area).toBe('conflicted')
    expect(neighbour(sections, 'untracked', 'n', 1)).toBeNull()
  })
  it('没有暂存但有改动时提交全部', () => {
    expect(needsCommitAll(status({ unstaged: [f('a')] }))).toBe(true)
    expect(needsCommitAll(status({ staged: [f('a')], unstaged: [f('b')] }))).toBe(false)
    expect(needsCommitAll(status({}))).toBe(false)
  })
  it('面板窄于 560px 时只能行内显示', () => {
    expect(diffMode('split', 800)).toBe('split')
    expect(diffMode('split', 400)).toBe('inline')
    expect(diffMode('inline', 800)).toBe('inline')
  })
  it('路径拆分与「多久之前」', () => {
    expect(splitPath('src/a/b.ts')).toEqual({ name: 'b.ts', dir: 'src/a' })
    expect(splitPath('b.ts')).toEqual({ name: 'b.ts', dir: '' })
    const now = 10_000_000
    expect(ago(now - 10_000, now)).toBe('刚刚')
    expect(ago(now - 6 * 60_000, now)).toBe('6 分钟前')
    setCurrentLocale('en-US')
    expect(ago(now - 2 * 3600_000, now)).toBe('2 h ago')
  })
})

describe('输入框上方的拉取 / 推送（composer-git）', () => {
  it('没有远端或都同步了不显示；领先、落后、没推送过的分支显示', () => {
    expect(syncState(status({ ahead: 2 }))).toBeNull()
    const remote = { remotes: ['origin'], upstream: 'origin/main' }
    expect(syncState(status(remote))).toBeNull()
    expect(syncState(status({ ...remote, ahead: 2, behind: 1 }))).toEqual({ ahead: 2, behind: 1, unpublished: false })
    expect(syncState(status({ remotes: ['origin'] }))).toEqual({ ahead: 0, behind: 0, unpublished: true })
    expect(syncState(status({ remotes: ['origin'], detached: true, branch: null }))).toBeNull()
    expect(syncState(status({ remotes: ['origin'], initial: true }))).toBeNull()
  })
})

describe('sameGitDiff', () => {
  const d = { path: 'staged.js', original: 'a', modified: 'OLD', binary: false, tooLarge: false }
  it('内容一样才算同一份（状态刷新后重读：一样就不替换）', () => {
    expect(sameGitDiff(d, { ...d })).toBe(true)
    expect(sameGitDiff(d, { ...d, modified: 'NEW' })).toBe(false)
    expect(sameGitDiff(d, { ...d, original: null })).toBe(false)
    expect(sameGitDiff(d, { ...d, tooLarge: true })).toBe(false)
  })
})
