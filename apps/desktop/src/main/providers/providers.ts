// 自定义 API（docs/ui/custom-api.md §4.4）：接口配置的 IPC。Key 只在主进程里，设置页拿到的都打了码
import { join } from 'node:path'
import { app } from 'electron'
import type { ProviderInput } from '../../shared/types/providers'
import type { AppContext } from '../app/context'
import { systemCipher } from '../app/system-cipher'
import { ProviderStore } from '../core/providers/store'
import { relayBilling } from '../core/providers/relay'
import { fetchModels, testProvider } from '../core/providers/upstream'
import * as ipc from '../ipc/guard'

const providerId = (id: unknown): string => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('无效的接口')
  return id
}

export function initProviders(ctx: AppContext): ProviderStore {
  const store = new ProviderStore(join(app.getPath('userData'), 'providers'), systemCipher)
  const changed = (): void => ctx.events.broadcast('providers:changed', store.state())
  const upstream = (url: string, init: RequestInit): Promise<Response> => fetch(url, init)

  ipc.handle('providers:list', () => store.state())
  ipc.handle('providers:save', (_e, input: unknown) => {
    const view = store.save(input as ProviderInput)
    changed()
    return view
  })
  ipc.handle('providers:remove', (_e, id: unknown) => {
    store.remove(providerId(id))
    changed()
  })
  // 测试连接、读取模型都收对话框里的配置（可能还没保存）；Key 留空时沿用已保存的
  ipc.handle('providers:test', (_e, input: unknown) => testProvider(store.draft(input as ProviderInput), upstream))
  ipc.handle('providers:models', (_e, input: unknown) => fetchModels(store.draft(input as ProviderInput), upstream))
  ipc.handle('providers:billing', (_e, input: unknown) => relayBilling(store.draft(input as ProviderInput), upstream))
  return store
}
