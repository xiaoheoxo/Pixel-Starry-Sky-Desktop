import { dotError } from './errors'
import { useEffect, useSyncExternalStore } from 'react'
import type { DotCatalogState } from '../../../../shared/types/dot-chat'

/**
 * Dot 入口只对「本机登录着 ChatGPT Pro」的用户显示（docs/ui/dot-optimize.md §2）：eligible 由主进程逐个账号核对后给出，
 * 侧栏、模型通道卡片、会话列表、标签都按它。checked：至少核对过一次（核对前不关标签，免得启动时误关）
 */
let state: DotCatalogState & { loading: boolean; checked: boolean } = {
  eligible: false,
  entries: [],
  errors: [],
  loading: false,
  checked: false,
}
const listeners = new Set<() => void>()
let pending: Promise<void> | null = null
let started = false
let accountKey = ''
const publish = (): void => listeners.forEach(fn => fn())

export function refreshDots(): Promise<void> {
  if (pending) return pending
  const api = window.pixelsky?.dotChat
  if (!api) return Promise.resolve()
  state = { ...state, loading: true }
  publish()
  pending = api
    .catalog(true)
    .then(
      next => {
        state = { ...next, loading: false, checked: true }
      },
      error => {
        state = { ...state, loading: false, errors: [dotError(error)] }
      },
    )
    .finally(() => {
      pending = null
      publish()
    })
  return pending
}

export function useDots() {
  useEffect(() => {
    if (started) return
    started = true
    window.pixelsky?.engine.onEvent(event => {
      if (event.kind !== 'engine_accounts' || event.accounts.engine !== 'codex') return
      const key = JSON.stringify(event.accounts.accounts.map(a => [a.id, a.email, a.plan, a.status]))
      if (accountKey === key) return
      accountKey = key
      // 列表刷新本身也会广播账号；只在账号内容改变时触发，避免循环查询。
      window.setTimeout(() => {
        void refreshDots()
      }, 500)
    })
    void refreshDots()
  }, [])
  return useSyncExternalStore(
    fn => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    () => state,
    () => state,
  )
}
