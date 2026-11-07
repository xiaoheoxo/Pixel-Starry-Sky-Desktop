import { describe, expect, it } from 'vitest'
import { routeWorkspaceTool } from './routingModel'

describe('routeWorkspaceTool', () => {
  it('终端进底栏，git 和文件进左栏', () => {
    expect(routeWorkspaceTool('terminal')).toEqual({ panel: 'bottom', tab: 'terminal' })
    expect(routeWorkspaceTool('git')).toEqual({ panel: 'left', view: 'git' })
    expect(routeWorkspaceTool('files')).toEqual({ panel: 'left', view: 'files' })
  })
  it('其它工具进右栏同名视图', () => {
    for (const id of ['artifacts', 'browser', 'tasks', 'sandbox', 'copies'])
      expect(routeWorkspaceTool(id)).toEqual({ panel: 'right', view: id })
  })
  it('评论、连接器、概况在代码模式没有地方放：图标位置里的按钮靠这个判断隐藏', () => {
    expect(routeWorkspaceTool('comments')).toBeNull()
    expect(routeWorkspaceTool('connectors')).toBeNull()
    expect(routeWorkspaceTool('overview')).toBeNull()
  })
  it('文件标签和不认识的 id 返回 null', () => {
    expect(routeWorkspaceTool('file:abc')).toBeNull()
    expect(routeWorkspaceTool('nope')).toBeNull()
    expect(routeWorkspaceTool('toString')).toBeNull()
    expect(routeWorkspaceTool('')).toBeNull()
  })
})
