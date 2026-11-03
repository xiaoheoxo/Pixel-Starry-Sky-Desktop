import { describe, expect, it } from 'vitest'
import {
  EMPTY_PANE,
  activateInPane,
  closeInGroup,
  cycleInGroup,
  focusGroup,
  lruToRelease,
  mapGroups,
  openInGroup,
  parseCodeTabs,
  pathKey,
  persistable,
  reopenedView,
  replaceInGroup,
  splitRight,
  updateGroup,
  withView,
} from './codeTabsModel'

const g = (tabs: string[], active: string | null) => ({ tabs, active })
const one = (tabs: string[], active: string | null) => ({ groups: [g(tabs, active)], focus: 0 })

describe('parseCodeTabs', () => {
  it('丢掉坏数据', () => {
    expect(parseCodeTabs(null)).toEqual({})
    expect(parseCodeTabs([])).toEqual({})
    expect(parseCodeTabs({ a: 1, b: { tabs: 'x' }, c: { tabs: [] } })).toEqual({})
  })
  it('只留 file: 标签并去重，active 不在列表里时取第一个', () => {
    expect(parseCodeTabs({ p: { tabs: ['file:a', 'x', 'file:a', 'file:b', 3], active: 'file:zzz' } })).toEqual({
      p: one(['file:a', 'file:b'], 'file:a'),
    })
    expect(parseCodeTabs({ p: { tabs: ['file:a', 'file:b'], active: 'file:b' } }).p).toEqual(
      one(['file:a', 'file:b'], 'file:b'),
    )
  })
  it('读出分屏的右组和当前组', () => {
    const raw = { p: { tabs: ['file:a'], active: 'file:a', right: { tabs: ['file:b'], active: 'file:b' }, focus: 1 } }
    expect(parseCodeTabs(raw).p).toEqual({ groups: [g(['file:a'], 'file:a'), g(['file:b'], 'file:b')], focus: 1 })
  })
  it('右组坏了只剩一组；左组空了右组顶上', () => {
    expect(parseCodeTabs({ p: { tabs: ['file:a'], right: { tabs: 'x' }, focus: 1 } }).p).toEqual(
      one(['file:a'], 'file:a'),
    )
    expect(parseCodeTabs({ p: { tabs: [], right: { tabs: ['file:b'] }, focus: 1 } }).p).toEqual(
      one(['file:b'], 'file:b'),
    )
    expect(parseCodeTabs({ p: null })).toEqual({})
  })
})

describe('persistable', () => {
  it('单组照旧存成 { tabs, active }，老版本读得懂', () => {
    expect(persistable({ p: one(['file:a', 'gitdiff:1'], 'gitdiff:1') })).toEqual({ p: g(['file:a'], 'file:a') })
  })
  it('分屏存 right 和 focus，读回来一样', () => {
    const pane = { groups: [g(['file:a'], 'file:a'), g(['file:a', 'file:b'], 'file:b')], focus: 1 }
    const stored = persistable({ p: pane })
    expect(stored.p).toEqual({ tabs: ['file:a'], active: 'file:a', right: g(['file:a', 'file:b'], 'file:b'), focus: 1 })
    expect(parseCodeTabs(JSON.parse(JSON.stringify(stored)))).toEqual({ p: pane })
  })
  it('只剩对比标签的组不存，当前组跟着回到剩下那组', () => {
    const pane = { groups: [g(['file:a'], 'file:a'), g(['gitdiff:1'], 'gitdiff:1')], focus: 1 }
    expect(persistable({ p: pane, q: one(['gitdiff:2'], 'gitdiff:2') })).toEqual({ p: g(['file:a'], 'file:a') })
  })
})

describe('分屏', () => {
  it('向右分屏：当前标签在右边新开一组并成为当前', () => {
    expect(splitRight(one(['a', 'b'], 'b'))).toEqual({ groups: [g(['a', 'b'], 'b'), g(['b'], 'b')], focus: 1 })
  })
  it('已经两组、没有当前标签时不动', () => {
    const two = splitRight(one(['a'], 'a'))
    expect(splitRight(two)).toBe(two)
    expect(splitRight(EMPTY_PANE)).toBe(EMPTY_PANE)
  })
  it('点另一组的标签：那组成为当前', () => {
    const two = { groups: [g(['a', 'b'], 'a'), g(['c'], 'c')], focus: 1 }
    expect(activateInPane(two, 0, 'b')).toEqual({ groups: [g(['a', 'b'], 'b'), g(['c'], 'c')], focus: 0 })
    expect(activateInPane(two, 1, 'c')).toBe(two)
    expect(activateInPane(two, 1, 'a')).toBe(two)
  })
  it('focusGroup 只认存在的组', () => {
    const two = { groups: [g(['a'], 'a'), g(['c'], 'c')], focus: 1 }
    expect(focusGroup(two, 0).focus).toBe(0)
    expect(focusGroup(two, 1)).toBe(two)
    expect(focusGroup(two, 5)).toBe(two)
  })
  it('关掉一组最后一个标签回到一组，当前落到剩下那组', () => {
    const two = { groups: [g(['a', 'b'], 'a'), g(['b'], 'b')], focus: 1 }
    expect(updateGroup(two, 1, closeInGroup(g(['b'], 'b'), 'b'))).toEqual(one(['a', 'b'], 'a'))
    const leftFocused = { ...two, focus: 0 }
    expect(updateGroup(leftFocused, 0, g([], null))).toEqual(one(['b'], 'b'))
  })
  it('关某组的标签不动另一组', () => {
    const two = { groups: [g(['a', 'b'], 'b'), g(['b'], 'b')], focus: 0 }
    expect(updateGroup(two, 0, closeInGroup(two.groups[0]!, 'b'))).toEqual({
      groups: [g(['a'], 'a'), g(['b'], 'b')],
      focus: 0,
    })
  })
  it('每组都关（Git 对比被关掉）：两组都没了就是空的', () => {
    const two = { groups: [g(['x'], 'x'), g(['x'], 'x')], focus: 1 }
    expect(mapGroups(two, gr => closeInGroup(gr, 'x'))).toBe(EMPTY_PANE)
  })
})

describe('每组自己的视图', () => {
  const diff = { mode: 'diff' as const, base: 'head' as const }
  it('分屏带上当前标签的视图，之后两组各改各的', () => {
    const two = splitRight({ groups: [withView(g(['a'], 'a'), 'a', diff)], focus: 0 })
    expect(two.groups[1]!.views).toEqual({ a: diff })
    const right = withView(two.groups[1]!, 'a', { mode: 'code', base: 'head' })
    expect(updateGroup(two, 1, right).groups[0]!.views).toEqual({ a: diff })
  })
  it('切换、打开标签保留视图，关掉的标签视图删掉，改名跟着换 id', () => {
    const group = withView(g(['a', 'b'], 'a'), 'a', diff)
    expect(openInGroup(group, 'x').views).toEqual({ a: diff })
    expect(activateInPane({ groups: [group], focus: 0 }, 0, 'b').groups[0]!.views).toEqual({ a: diff })
    expect(closeInGroup(group, 'a').views).toEqual({})
    expect(replaceInGroup(group, 'a', 'z')).toEqual({ tabs: ['z', 'b'], active: 'z', views: { z: diff } })
  })
})

describe('openInGroup', () => {
  it('已有就激活', () => {
    expect(openInGroup(g(['a', 'b'], 'a'), 'b')).toEqual(g(['a', 'b'], 'b'))
  })
  it('新的插到当前标签右边', () => {
    expect(openInGroup(g(['a', 'b', 'c'], 'a'), 'x')).toEqual(g(['a', 'x', 'b', 'c'], 'x'))
  })
  it('没有当前标签时放最后', () => {
    expect(openInGroup(g(['a'], null), 'x')).toEqual(g(['a', 'x'], 'x'))
    expect(openInGroup(g([], null), 'x')).toEqual(g(['x'], 'x'))
  })
})

describe('closeInGroup', () => {
  it('关当前标签激活右边那个', () => {
    expect(closeInGroup(g(['a', 'b', 'c'], 'b'), 'b')).toEqual(g(['a', 'c'], 'c'))
  })
  it('右边没有就激活左边', () => {
    expect(closeInGroup(g(['a', 'b'], 'b'), 'b')).toEqual(g(['a'], 'a'))
    expect(closeInGroup(g(['a'], 'a'), 'a')).toEqual(g([], null))
  })
  it('关别的标签不改当前标签', () => {
    expect(closeInGroup(g(['a', 'b', 'c'], 'a'), 'c')).toEqual(g(['a', 'b'], 'a'))
  })
  it('不存在的 id 原样返回', () => {
    const group = g(['a'], 'a')
    expect(closeInGroup(group, 'zz')).toBe(group)
  })
})

describe('cycleInGroup', () => {
  it('绕回另一头', () => {
    expect(cycleInGroup(g(['a', 'b', 'c'], 'c'), 1).active).toBe('a')
    expect(cycleInGroup(g(['a', 'b', 'c'], 'a'), -1).active).toBe('c')
    expect(cycleInGroup(g(['a', 'b', 'c'], 'a'), 1).active).toBe('b')
  })
  it('少于两个标签不动', () => {
    const group = g(['a'], 'a')
    expect(cycleInGroup(group, 1)).toBe(group)
  })
})

describe('lruToRelease', () => {
  it('没超上限不释放', () => {
    expect(lruToRelease(['a', 'b'], 'b', new Set(), 2)).toEqual([])
  })
  it('最久的先释放，跳过当前和未保存的', () => {
    expect(lruToRelease(['a', 'b', 'c', 'd', 'e'], 'e', new Set(['a']), 3)).toEqual(['b', 'c'])
  })
  it('能释放的不够时只释放能释放的', () => {
    expect(lruToRelease(['a', 'b', 'c'], 'c', new Set(['a', 'b']), 1)).toEqual([])
  })
})

describe('pathKey', () => {
  it('统一分隔符和大小写', () => {
    expect(pathKey('.\\src\\A.ts', true)).toBe('src/a.ts')
    expect(pathKey('src/A.ts', false)).toBe('src/A.ts')
  })
})

describe('reopenedView', () => {
  it('停在「变更 / 并排」的回到默认视图，对比基准留着', () => {
    expect(reopenedView({ mode: 'diff', base: 'head' })).toEqual({ base: 'head' })
    expect(reopenedView({ mode: 'split', base: 'turn' })).toEqual({ base: 'turn' })
  })
  it('「代码 / 预览」是用户选的，原样不动', () => {
    const code = { mode: 'code' as const, base: 'head' as const }
    const preview = { mode: 'preview' as const, base: 'turn' as const }
    expect(reopenedView(code)).toBe(code)
    expect(reopenedView(preview)).toBe(preview)
    expect(reopenedView({ base: 'head' })).toEqual({ base: 'head' })
  })
  it('没记过就还是没有', () => {
    expect(reopenedView(undefined)).toBeUndefined()
  })
})
