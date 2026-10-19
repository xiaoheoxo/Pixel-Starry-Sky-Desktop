import { describe, expect, it, vi } from 'vitest'
import { parseCodedError } from '@pixelsky/protocol'
import type { CheckProcess } from './check-host'

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))

const { createCheckHost } = await import('./check-host')

/** 收到 check 就回一份没问题的报告的假检查进程 */
function fakeProcess(posted: Array<{ tmpDir: string }>): CheckProcess {
  const listeners: Array<(m: unknown) => void> = []
  return {
    postMessage(message) {
      posted.push(message as { tmpDir: string })
      for (const l of listeners)
        l({
          type: 'result',
          requestId: 1,
          report: { check: { issues: [] }, verdict: { blocking: 0, counts: { hint: 0 } } },
        })
    },
    on(event: string, listener: (m: never) => void) {
      if (event === 'message') listeners.push(listener as (m: unknown) => void)
      return undefined
    },
    kill: () => true,
  } as CheckProcess
}

describe('createCheckHost 的 whenReady', () => {
  it('启动清理没跑完之前不起检查进程、不给临时目录；好了以后才开始', async () => {
    const posted: Array<{ tmpDir: string }> = []
    const fork = vi.fn(() => fakeProcess(posted))
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const run = createCheckHost({
      fork,
      workerPath: '/w.js',
      tmpRoot: '/store/.tmp',
      whenReady: () => gate,
      rm: async () => undefined,
      randomName: () => 'abc',
    })
    const result = run(Buffer.from('zip'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fork).not.toHaveBeenCalled()
    release()
    expect(await result).toMatchObject({ incomplete: false, blocking: 0 })
    expect(posted[0].tmpDir.split('\\').join('/')).toBe('/store/.tmp/check-abc')
  })

  it('等待期间被取消：抛 extstore.cancelled，不起进程', async () => {
    const fork = vi.fn()
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const run = createCheckHost({ fork, workerPath: '/w.js', tmpRoot: '/t', whenReady: () => gate })
    const ctrl = new AbortController()
    const result = run(Buffer.from('zip'), ctrl.signal).catch((e: Error) => e)
    ctrl.abort()
    release()
    const err = await result
    expect(parseCodedError((err as Error).message)?.code).toBe('extstore.cancelled')
    expect(fork).not.toHaveBeenCalled()
  })
})
