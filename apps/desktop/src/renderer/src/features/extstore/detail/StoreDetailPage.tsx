import { useEffect, useMemo, useState } from 'react'
import type { ExtPackInfo, ExtStoreReportInput } from '@pixelsky/protocol'
import { tr, translateMessage } from '@/i18n/core'
import { useAccount } from '@/features/account'
import { refreshPacks, usePackState } from '@/features/extpacks/store'
import { openExtDetail } from '../nav'
import { cancelInstall, installExtension, storeBridge, useExtStore } from '../store'
import { storeIconSrc } from '../storeModel'
import { hasDevCopy } from './detailActions'
import { failedResult, localLoadKey, type DetailResult } from './detailLoad'
import { StoreDetail } from './StoreDetail'

// 详情页的接线：取详情、从状态单例和扩展列表拼出 StoreDetail 要的 props、把按钮接到通道。
// StoreDetail 本身 props 驱动（测试好测），这里不放界面。

const errorText = (e: unknown): string => translateMessage((e as Error)?.message ?? String(e))

/** 本机同 id 的扩展：优先商店装的，其次开发中的文件夹，最后内置 */
export function localPackOf(packs: readonly ExtPackInfo[], id: string): ExtPackInfo | null {
  const same = packs.filter(p => p.id === id)
  return same.find(p => p.source === 'store') ?? same.find(p => p.source === 'folder') ?? same[0] ?? null
}

/** 当前像素星空版本；取不到时是空串（版本要求就不拦） */
function useAppVersion(): string {
  const [version, setVersion] = useState('')
  useEffect(() => {
    let alive = true
    window.pixelsky?.app
      ?.getInfo()
      .then(info => alive && setVersion(info.version))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return version
}

export function StoreDetailPage({ id }: { id: string }) {
  const store = useExtStore()
  const { packs } = usePackState()
  const account = useAccount()
  const appVersion = useAppVersion()
  // 取详情的结果：null = 还没取到过（第一次打开、点了重试）；detail 是 null 时云端回的 404。
  // 装好 / 启停之后重新取时保留上一次的结果，不闪「已下架」
  const [result, setResult] = useState<DetailResult | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const localPack = useMemo(() => localPackOf(packs, id), [packs, id])
  const localKey = localLoadKey(localPack)

  // 打开、本机那份变了（见 localLoadKey）、点重试时取。只有 404 回 null（下架）；
  // 5xx、连不上等主进程抛出来的错误留着文案，界面显示错误和「重试」，不当成下架
  useEffect(() => {
    let alive = true
    const bridge = storeBridge()
    if (!bridge) {
      setResult({ detail: null, error: null })
      return
    }
    bridge
      .detail(id)
      .then(d => alive && setResult({ detail: d, error: null }))
      .catch(e => alive && setResult(prev => failedResult(prev, errorText(e))))
    return () => {
      alive = false
    }
  }, [id, localKey, attempt])

  const detail = result?.detail ?? null
  const retry = (): void => {
    setResult(null)
    setAttempt(n => n + 1)
  }

  const run = async (job: () => Promise<unknown> | undefined): Promise<void> => {
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
      await job()
      await refreshPacks()
    } catch (e) {
      setActionError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const extpacks = window.pixelsky?.extpacks
  const version = detail?.extension.version ?? localPack?.store?.version ?? ''
  return (
    <StoreDetail
      id={id}
      detail={detail}
      localPack={localPack}
      update={store.state.updates[id]}
      appVersion={appVersion}
      devCopy={hasDevCopy(packs, id)}
      progress={store.state.installing[id]}
      busy={busy}
      error={actionError ?? store.installErrors[id] ?? null}
      iconSrc={detail ? storeIconSrc(detail.extension) : version ? `pixelsky-ext://store-icon/${id}/${version}` : null}
      loading={result === null}
      loadError={result?.error ?? null}
      onRetry={retry}
      signedIn={account.status === 'signed-in'}
      onBack={() => openExtDetail(null)}
      onInstall={(v, options) => {
        // 版本是按当前取到的详情算的；详情还是上一个扩展的（切换瞬间）时不装，免得把 A 的版本装给 B
        if (detail && detail.extension.id !== id) return
        void installExtension(id, v, { ...options, name: detail?.extension.name })
      }}
      onCancelInstall={() => void cancelInstall(id)}
      onUninstall={() => {
        if (localPack) void run(() => extpacks?.remove(localPack.key))
      }}
      onSetEnabled={enabled => {
        if (localPack) void run(() => extpacks?.setEnabled(localPack.key, enabled))
      }}
      onReport={(input: ExtStoreReportInput) => {
        const bridge = storeBridge()
        return bridge ? bridge.report(id, input) : Promise.reject(new Error(tr('extstoreDetail.notFound')))
      }}
      onLogin={() => void account.login()}
    />
  )
}
