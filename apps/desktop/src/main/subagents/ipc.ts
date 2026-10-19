// 设置 › 子智能体的 IPC（docs/ui/subagent-routing.md）：只在本机；远程机器上的像素星空会话也由本机网关转发，用同一份设置
import { app } from 'electron'
import type { AppContext } from '../app/context'
import * as ipc from '../ipc/guard'
import { SubagentSettingsStore } from './store'

export function initSubagents(ctx: AppContext): SubagentSettingsStore {
  const store = new SubagentSettingsStore(app.getPath('userData'))
  ipc.handle('subagents:get', () => store.get())
  ipc.handle('subagents:set', (_e, input: unknown) => {
    const saved = store.set(input)
    ctx.events.broadcast('subagents:changed', saved)
    return saved
  })
  return store
}
