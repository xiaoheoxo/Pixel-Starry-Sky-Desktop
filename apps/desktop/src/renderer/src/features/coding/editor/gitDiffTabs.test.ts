import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitCode } from '../../../../../shared/types/project-tools'
import { EMPTY_GROUP } from './codeTabsModel'

// 标签组用内存里的一份顶替真正的 codeTabs（它带着编辑器和 localStorage）
const state = vi.hoisted(() => ({ group: { tabs: [] as string[], active: null as string | null } }))
vi.mock('./codeTabs', async () => {
  const model = await import('./codeTabsModel')
  return {
    allCodeTabIds: () => new Set(state.group.tabs),
    openPseudoTab: (id: string) => {
      state.group = model.openInGroup(state.group, id)
    },
    replaceCodeTab: (from: string, to: string) => {
      state.group = model.replaceInGroup(state.group, from, to)
    },
    closeCodeTab: async (id: string) => {
      state.group = model.closeInGroup(state.group, id)
      return true
    },
    useCodeTabs: () => ({ group: state.group }),
  }
})

const {
  commitDiffInput,
  getGitDiffTab,
  gitPanelKey,
  gitStatusRevision,
  inGitWorkspace,
  noteGitHead,
  openGitDiffTab,
  setGitFileKey,
  syncGitDiffTabs,
  workDiffInput,
} = await import('./gitDiffTabs')

const ref = { projectId: 'p1' }
const file = (path: string, code: GitCode = 'M') => ({ path, origPath: null, code, local: path, submodule: false })
const commitFile = { path: 'a.ts', origPath: null, code: 'M' as const, insertions: 1, deletions: 0 }

beforeEach(() => {
  state.group = EMPTY_GROUP
})

describe('状态版本和 HEAD', () => {
  it('每读到一次状态，这个工作区的版本加一（文件还在同一区、字母没变时对比标签靠它重读）', () => {
    const before = gitStatusRevision('p:rev')
    const sections = [{ area: 'staged' as const, files: [file('staged.js')] }]
    syncGitDiffTabs('p:rev', sections)
    syncGitDiffTabs('p:rev', sections)
    expect(gitStatusRevision('p:rev')).toBe(before + 2)
    expect(gitStatusRevision('p:other')).toBe(0)
  })
  it('noteGitHead：第一次看到不算换了，之后提交号变了才算', () => {
    expect(noteGitHead('p:head', 'aaa')).toBe(false)
    expect(noteGitHead('p:head', 'aaa')).toBe(false)
    expect(noteGitHead('p:head', 'bbb')).toBe(true)
    expect(noteGitHead('p:head', 'bbb')).toBe(false)
    // 空仓库第一次提交
    expect(noteGitHead('p:empty', null)).toBe(false)
    expect(noteGitHead('p:empty', 'ccc')).toBe(true)
  })
})

describe('inGitWorkspace', () => {
  it('按工作区匹配文件标签；附加文件夹「::N/」对应「#N」的面板；会话在项目里的别名也认', () => {
    expect(inGitWorkspace('p:w1')({ ref: { projectId: 'w1' }, path: 'src/a.ts' })).toBe(true)
    expect(inGitWorkspace('p:w1')({ ref: { projectId: 'w1' }, path: '::1/a.ts' })).toBe(false)
    expect(inGitWorkspace('p:w1#1')({ ref: { projectId: 'w1' }, path: '::1/a.ts' })).toBe(true)
    expect(inGitWorkspace('p:w1#1')({ ref: { projectId: 'w1', folder: 1 }, path: 'a.ts' })).toBe(true)
    expect(inGitWorkspace('p:w1')({ ref: { projectId: 'w2' }, path: 'a.ts' })).toBe(false)
    setGitFileKey('s:sess-w3', 'p:w3')
    expect(inGitWorkspace('s:sess-w3')({ ref: { projectId: 'w3' }, path: 'a.ts' })).toBe(true)
  })
})

describe('Git 对比标签 store', () => {
  it('打开：进标签组并记下数据；再点同一文件 + 区是激活已有的', () => {
    const a = openGitDiffTab(workDiffInput(ref, 'p:p1', false, 'unstaged', file('a.ts')))
    const b = openGitDiffTab(workDiffInput(ref, 'p:p1', false, 'unstaged', file('b.ts')))
    expect(state.group).toEqual({ tabs: [a, b], active: b })
    expect(getGitDiffTab(a)?.path).toBe('a.ts')
    expect(openGitDiffTab(workDiffInput(ref, 'p:p1', false, 'unstaged', file('a.ts')))).toBe(a)
    expect(state.group).toEqual({ tabs: [a, b], active: a })
    // 同一文件换个区是另一个标签
    const staged = openGitDiffTab(workDiffInput(ref, 'p:p1', false, 'staged', file('a.ts')))
    expect(staged).not.toBe(a)
    expect(state.group.tabs).toHaveLength(3)
  })

  it('历史里的提交文件：按提交区分，带提交信息', () => {
    const c1 = openGitDiffTab(commitDiffInput(ref, 'p:p1', false, commitFile, 'p0', 'c1', 'c1'))
    const c2 = openGitDiffTab(commitDiffInput(ref, 'p:p1', false, commitFile, 'c1', 'c2'))
    expect(c1).not.toBe(c2)
    expect(getGitDiffTab(c1)).toMatchObject({ area: 'commit', to: 'c1', caption: 'c1' })
  })

  it('历史里的提交文件带上工作区路径（标签右上角能「打开文件」）；后来删掉的没有', () => {
    expect(commitDiffInput(ref, 'p:p1', false, { ...commitFile, local: 'a.ts' }, 'p0', 'c1').local).toBe('a.ts')
    expect(commitDiffInput(ref, 'p:p1', false, { ...commitFile, local: null }, 'p0', 'c1').local).toBeNull()
    expect(commitDiffInput(ref, 'p:p1', false, commitFile, 'p0', 'c1').local).toBeNull()
  })

  it('暂存：标签换到暂存区，位置和激活不变；还原 / 提交：关掉', async () => {
    const a = openGitDiffTab(workDiffInput(ref, 'p:p1', false, 'unstaged', file('a.ts')))
    const other = openGitDiffTab(workDiffInput(ref, 'p:p1', false, 'untracked', file('n.ts', '?')))
    state.group = { tabs: state.group.tabs, active: a }
    syncGitDiffTabs('p:p1', [
      { area: 'staged', files: [{ path: 'a.ts', code: 'M' }] },
      { area: 'untracked', files: [{ path: 'n.ts', code: '?' }] },
    ])
    expect(state.group.tabs).toHaveLength(2)
    const moved = state.group.active!
    expect(moved).not.toBe(a)
    expect(getGitDiffTab(moved)).toMatchObject({ area: 'staged', path: 'a.ts' })
    expect(getGitDiffTab(a)).toBeUndefined()
    expect(state.group.tabs[1]).toBe(other)
    // 还原 n.ts：哪个区都没有了
    syncGitDiffTabs('p:p1', [{ area: 'staged', files: [{ path: 'a.ts', code: 'M' }] }])
    await Promise.resolve()
    expect(state.group.tabs).toEqual([moved])
  })

  it('别的工作区和提交里的标签不受状态刷新影响', async () => {
    const c = openGitDiffTab(commitDiffInput(ref, 'p:p1', false, commitFile, 'p0', 'c1'))
    const w = openGitDiffTab(workDiffInput({ projectId: 'p2' }, 'p:p2', false, 'unstaged', file('a.ts')))
    syncGitDiffTabs('p:p1', [])
    await Promise.resolve()
    expect(state.group.tabs).toEqual([c, w])
  })

  it('样式 A：会话在项目文件夹里时，文件标签的 key（项目）对到 Git 面板的 key（会话）', () => {
    expect(gitPanelKey('p:proj')).toBe('p:proj')
    setGitFileKey('s:sess', 'p:proj')
    expect(gitPanelKey('p:proj')).toBe('s:sess')
    setGitFileKey('p:p1', 'p:p1')
    expect(gitPanelKey('p:p1')).toBe('p:p1')
  })
})
