// 选择框调接口时带引擎：列表、补尾部、导入三个包装都把 engine 交给宿主（docs/ui/codex-resume.md §8）
import { describe, expect, it, vi } from 'vitest'

// bridge 在 store 加载时从 window.pixelsky 取，所以在导入之前放好
const engine = vi.hoisted(() => {
  const mock = {
    nativeSessions: vi.fn(async (..._args: unknown[]) => []),
    nativeSessionDetails: vi.fn(async (..._args: unknown[]) => []),
    importNativeSession: vi.fn(async (..._args: unknown[]) => ({ sessionId: 's1', model: null, turns: 1, shown: 1 })),
    onEvent: () => () => undefined,
  }
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    pixelsky: { engine: mock },
  }
  return mock
})
import { importNativeSession, listNativeSessions, nativeSessionDetails } from '@/features/engine/store'

describe('选择框的三个接口包装带 engine', () => {
  it('engine 为 codex：列表、补尾部、导入都交给宿主 codex', async () => {
    await listNativeSessions('p1', { engine: 'codex', subfolders: true })
    await nativeSessionDetails('p1', ['t1'], 'codex')
    await importNativeSession('p1', 't1', { engine: 'codex', mode: 'copy', settings: {}, token: 'k' })
    expect(engine.nativeSessions.mock.calls[0].slice(0, 2)).toEqual(['p1', 'codex'])
    expect(engine.nativeSessionDetails.mock.calls[0]).toEqual(['p1', 'codex', ['t1']])
    expect(engine.importNativeSession.mock.calls[0].slice(0, 3)).toEqual(['p1', 'codex', 't1'])
  })
  it('不传 engine 还是 Claude', async () => {
    engine.nativeSessions.mockClear()
    await listNativeSessions('p1')
    expect(engine.nativeSessions.mock.calls[0][1]).toBe('claude')
  })
})
