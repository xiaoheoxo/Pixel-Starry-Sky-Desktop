import { describe, expect, it } from 'vitest'
import {
  activatePanelTab,
  emptyPanel,
  parsePanel,
  panelCloseTargets,
  removePanelTabs,
  restorePanels,
} from './workspaceState'
import { fileTab } from '../panes/tree'

describe('right workspace resource layout', () => {
  const file = fileTab({ projectId: 'project-a' }, 'src/main.ts')
  it('restores valid resources and recovers from a removed active tab', () => {
    expect(parsePanel({ tabs: ['files', null, 'unknown-tool', file, file], active: 'unknown-tool' })).toEqual({
      tabs: ['files', file],
      active: 'files',
    })
    expect(parsePanel({ tabs: [], active: null })).toEqual({ tabs: [], active: null })
  })
  it('reopening the same file activates its existing tab', () => {
    const layout = { tabs: [file, 'terminal', 'browser'], active: 'browser' }
    expect(activatePanelTab(layout, file)).toEqual({ ...layout, active: file })
  })
  it('batch close targets are calculated before confirmation and preserve the selected tab', () => {
    const layout = { tabs: ['files', file, 'terminal', 'browser'], active: file }
    const targets = panelCloseTargets(layout, file, 'right')
    expect(targets).toEqual(['terminal', 'browser'])
    expect(removePanelTabs(layout, targets)).toEqual({ tabs: ['files', file], active: file })
    expect(removePanelTabs(layout, [file])).toEqual({ tabs: ['files', 'terminal', 'browser'], active: 'terminal' })
    expect(panelCloseTargets(layout, 'missing', 'all')).toEqual([])
  })
})

describe('概况标签', () => {
  const v1 = JSON.stringify({
    a: { tabs: ['files', 'git'], active: 'git' },
    closedAll: { tabs: [], active: null },
    bad: 'nope',
  })
  it('新作用域有概况但不选中，默认还是文件', () => {
    expect(emptyPanel).toEqual({ tabs: ['overview', 'files'], active: 'files' })
  })
  it('打开时放最前，其它工具排后面', () => {
    expect(activatePanelTab({ tabs: ['files'], active: 'files' }, 'overview')).toEqual({
      tabs: ['overview', 'files'],
      active: 'overview',
    })
    expect(activatePanelTab({ tabs: ['overview'], active: 'overview' }, 'git').tabs).toEqual(['overview', 'git'])
  })
  it('从 v1 迁移：概况放最前，选中的不变；全关了的不动', () => {
    const panels = restorePanels(null, v1)
    expect(panels.a).toEqual({ tabs: ['overview', 'files', 'git'], active: 'git' })
    expect(panels.closedAll).toEqual({ tabs: [], active: null })
    expect(panels.bad).toEqual(emptyPanel)
  })
  it('有 v2 就不再看 v1：关掉的概况不回来', () => {
    expect(restorePanels(JSON.stringify({ a: { tabs: ['files'], active: 'files' } }), v1)).toEqual({
      a: { tabs: ['files'], active: 'files' },
    })
  })
  it('两个都没有、或存的不是对象时为空；JSON 坏了抛错交给调用方', () => {
    expect(restorePanels(null, null)).toEqual({})
    expect(restorePanels('[]', null)).toEqual({})
    expect(() => restorePanels('{', null)).toThrow()
  })
})
