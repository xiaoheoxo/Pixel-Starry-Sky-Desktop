// 「上下文设置…」打开哪一页：omp 的引擎详情里没有上下文这一组，去模型通道
import { describe, expect, it, vi } from 'vitest'
import { hasContextSettings, openContextSettings } from './contextWindows'
import { takeModelsScroll } from './scroll'

const nav = vi.hoisted(() => ({ openEngineDetail: vi.fn() }))
vi.mock('../engines/nav', () => nav)
vi.mock('@/features/engine', () => ({ bridge: null, isLive: false, useEngineState: () => null }))
vi.mock('@/data/demo', () => ({ demo: () => null, isDemo: false }))

describe('上下文设置…', () => {
  it('omp 用自己登录的模型时不显示；走平台、自定义 API、还没建会话时显示', () => {
    const own = { engine: 'omp' as const, platform: null, provider: null }
    expect(hasContextSettings('omp', own)).toBe(false)
    expect(hasContextSettings('omp', { ...own, platform: { groupId: '7', account: 'a' } })).toBe(true)
    expect(hasContextSettings('omp', undefined)).toBe(true)
    expect(hasContextSettings('claude', { ...own, engine: 'claude' })).toBe(true)
  })

  it('omp 打开模型通道并滚到模型列表，其它引擎打开引擎详情', () => {
    const open = vi.fn()
    openContextSettings('omp', open)
    expect(open).toHaveBeenLastCalledWith('models')
    expect(takeModelsScroll()).toBe(true)
    expect(nav.openEngineDetail).not.toHaveBeenCalled()
    openContextSettings('claude', open)
    expect(open).toHaveBeenLastCalledWith('engines')
    expect(nav.openEngineDetail).toHaveBeenCalledWith('claude')
    expect(takeModelsScroll()).toBe(false)
  })
})
