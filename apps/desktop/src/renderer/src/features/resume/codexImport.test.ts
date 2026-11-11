import { expect, it, vi } from 'vitest'
import { CodexImportStore } from './codexImport'
import type { CodexWorkspaceImportResult } from '../../../../shared/types/codex-import'

const result: CodexWorkspaceImportResult = { groups: [], failed: [], addedProjects: 0, warnings: [] }

it('多次触发共用正在执行的读取，离开页面后仍保留结果；失败可重新读取', async () => {
  let complete!: (result: CodexWorkspaceImportResult) => void
  const read = vi.fn(
    () =>
      new Promise<CodexWorkspaceImportResult>(resolve => {
        complete = resolve
      }),
  )
  const store = new CodexImportStore(read)
  const first = store.read()
  expect(store.getSnapshot().running).toBe(true)
  expect(store.read()).toBe(first)
  expect(read).toHaveBeenCalledTimes(1)
  complete(result)
  await first
  expect(store.getSnapshot()).toEqual({ running: false, result, error: null })
  read.mockRejectedValueOnce(new Error('读取中断'))
  await store.read()
  expect(store.getSnapshot()).toEqual({ running: false, result, error: '读取中断' })
  const retry = store.read()
  complete(result)
  await retry
  expect(store.getSnapshot().error).toBeNull()
})
