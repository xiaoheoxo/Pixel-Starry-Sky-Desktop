import { describe, expect, it } from 'vitest'
import { GIT_DIFF_PREFIX, persistable, replaceInGroup } from './codeTabsModel'
import {
  diffActions,
  diffTag,
  gitDiffId,
  gitOpenTarget,
  parseGitOpenStyle,
  planSync,
  routeGitDiff,
} from './gitDiffModel'

const g = (tabs: string[], active: string | null) => ({ tabs, active })

describe('gitDiffId', () => {
  it('同一文件 + 区 + 提交是同一个 id，区或提交不同就不同', () => {
    const a = { refKey: 'p:1', area: 'staged' as const, path: 'src/a.ts' }
    expect(gitDiffId(a)).toBe(gitDiffId({ ...a }))
    expect(gitDiffId(a).startsWith(GIT_DIFF_PREFIX)).toBe(true)
    expect(gitDiffId({ ...a, area: 'unstaged' })).not.toBe(gitDiffId(a))
    expect(gitDiffId({ ...a, area: 'commit', from: 'x', to: 'y' })).not.toBe(
      gitDiffId({ ...a, area: 'commit', from: 'x', to: 'z' }),
    )
    expect(gitDiffId({ ...a, refKey: 'p:2' })).not.toBe(gitDiffId(a))
  })
})

describe('diffTag / diffActions', () => {
  it('标签：更改 / 暂存 / 提交短哈希', () => {
    expect(diffTag('unstaged', null)).toEqual({ kind: 'work' })
    expect(diffTag('untracked', null)).toEqual({ kind: 'work' })
    expect(diffTag('staged', null)).toEqual({ kind: 'staged' })
    expect(diffTag('commit', '0123456789abcdef')).toEqual({ kind: 'commit', hash: '0123456' })
  })
  it('动作：更改 / 未跟踪暂存 + 还原，暂存取消暂存，提交只读', () => {
    expect(diffActions('unstaged')).toEqual({ stage: true, unstage: false, discard: true })
    expect(diffActions('untracked')).toEqual({ stage: true, unstage: false, discard: true })
    expect(diffActions('staged')).toEqual({ stage: false, unstage: true, discard: false })
    expect(diffActions('commit')).toEqual({ stage: false, unstage: false, discard: false })
  })
})

describe('routeGitDiff', () => {
  it('中栏注册了打开方式放中栏，没有就在面板里', () => {
    expect(routeGitDiff(true)).toBe('center')
    expect(routeGitDiff(false)).toBe('inline')
  })
})

describe('planSync', () => {
  const at = (map: Record<string, string>) => (area: string) => map[area] ?? null
  it('还在原来的区：保留；状态字母变了就刷新', () => {
    expect(planSync('unstaged', 'M', at({ unstaged: 'M' }))).toEqual({ kind: 'keep' })
    expect(planSync('unstaged', 'M', at({ unstaged: 'D' }))).toEqual({ kind: 'refresh', code: 'D' })
  })
  it('暂存后跟着去暂存区，取消暂存后回到更改 / 未跟踪', () => {
    expect(planSync('unstaged', 'M', at({ staged: 'M' }))).toEqual({ kind: 'move', area: 'staged', code: 'M' })
    expect(planSync('untracked', '?', at({ staged: 'A' }))).toEqual({ kind: 'move', area: 'staged', code: 'A' })
    expect(planSync('staged', 'A', at({ untracked: '?' }))).toEqual({ kind: 'move', area: 'untracked', code: '?' })
    expect(planSync('staged', 'M', at({ unstaged: 'M' }))).toEqual({ kind: 'move', area: 'unstaged', code: 'M' })
  })
  it('哪个区都没有了（还原 / 提交）：关闭', () => {
    expect(planSync('unstaged', 'M', at({}))).toEqual({ kind: 'close' })
  })
})

describe('replaceInGroup / persistable', () => {
  it('换标签保持位置和激活', () => {
    expect(replaceInGroup(g(['a', 'b', 'c'], 'b'), 'b', 'x')).toEqual(g(['a', 'x', 'c'], 'x'))
    expect(replaceInGroup(g(['a', 'b', 'c'], 'a'), 'b', 'x')).toEqual(g(['a', 'x', 'c'], 'a'))
  })
  it('新 id 已经开着：只留那一个', () => {
    expect(replaceInGroup(g(['a', 'b', 'x'], 'b'), 'b', 'x')).toEqual(g(['a', 'x'], 'x'))
  })
  it('持久化不含对比标签，只剩对比标签的项目不存', () => {
    const d = `${GIT_DIFF_PREFIX}p:1:staged:..:a`
    expect(
      persistable({ p: { groups: [g(['file:a', d], d)], focus: 0 }, q: { groups: [g([d], d)], focus: 0 } }),
    ).toEqual({ p: g(['file:a'], 'file:a') })
  })
})

describe('样式 A / B：工作区改动怎么打开', () => {
  it('设置缺失或损坏时是样式 A（file），只认 diff', () => {
    for (const v of [undefined, null, '', 'x', 1]) expect(parseGitOpenStyle(v)).toBe('file')
    expect(parseGitOpenStyle('diff')).toBe('diff')
  })
  it('样式 A：更改 / 未跟踪 / 冲突打开成文件标签；暂存、提交、删除的、不在工作区的仍是对比标签', () => {
    const f = (code: string, local: string | null = 'src/a.ts') => ({ code, local })
    expect(gitOpenTarget('file', 'unstaged', f('M'))).toBe('file')
    expect(gitOpenTarget('file', 'untracked', f('?'))).toBe('file')
    expect(gitOpenTarget('file', 'conflicted', f('U'))).toBe('file')
    expect(gitOpenTarget('file', 'staged', f('M'))).toBe('diff')
    expect(gitOpenTarget('file', 'commit', f('M'))).toBe('diff')
    expect(gitOpenTarget('file', 'unstaged', f('D'))).toBe('diff')
    expect(gitOpenTarget('file', 'unstaged', f('M', null))).toBe('diff')
  })
  it('样式 B：一律对比标签', () => {
    for (const area of ['unstaged', 'untracked', 'conflicted', 'staged', 'commit'] as const)
      expect(gitOpenTarget('diff', area, { code: 'M', local: 'a.ts' })).toBe('diff')
  })
})
