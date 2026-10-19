import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorState } from '../../../../shared/types/workspace'

// 编辑器偏好（默认打开方式、外部编辑器）：别的窗口改了，主进程广播 editor:changed，这个窗口重新取一次。

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const state = (defaultId: string): EditorState => ({ defaultId }) as unknown as EditorState

describe('watchEditorChanges', () => {
  it('加载过编辑器状态：收到广播就重新取并更新', async () => {
    const fetch = vi.fn(() => Promise.resolve(state('cursor')))
    vi.stubGlobal('window', { pixelsky: { editor: { state: fetch } } })
    const store = await import('./store')
    let notify: () => void = () => undefined
    const off = vi.fn()
    store.watchEditorChanges(cb => {
      notify = cb
      return off
    })
    store.setEditors(state('vscode'))
    notify()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(false))
    // 每次广播都重新取一次
    notify()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })

  it('还没加载过：不去取（用到时自然会取）', async () => {
    const fetch = vi.fn(() => Promise.resolve(state('x')))
    vi.stubGlobal('window', { pixelsky: { editor: { state: fetch } } })
    const store = await import('./store')
    let notify: () => void = () => undefined
    store.watchEditorChanges(cb => {
      notify = cb
      return () => undefined
    })
    notify()
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('模块加载时自己订阅预载桥的 onChanged', async () => {
    const onChanged = vi.fn(() => () => undefined)
    vi.stubGlobal('window', { pixelsky: { editor: { onChanged } } })
    await import('./store')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})
