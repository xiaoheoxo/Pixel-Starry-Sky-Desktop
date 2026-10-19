import { useEffect, useRef, useState } from 'react'
import { FolderPlus, RefreshCw } from 'lucide-react'
import type { ExtPackInfo } from '@pixelsky/protocol'
import { Button } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { useMachines } from '@/features/machines/store'
import { refreshPacks, usePackState } from '@/features/extpacks/store'
import { checkExtUpdates, installExtension, useExtStore } from '@/features/extstore/store'
import { InstalledTab } from '@/features/extstore/installed/InstalledTab'
import { runUpdateAll } from '@/features/extstore/installed/installedModel'
import { GroupTitle } from '../SettingRow'
import { PluginsSection } from '../plugins/PluginsSection'
import { packTitle, type PackGroup } from './model'
import { PackDetail } from './PackDetail'

const errorText = (e: unknown): string => translateMessage((e as Error)?.message ?? String(e))

/**
 * 「已安装」页签的接线：features/extstore/installed/InstalledTab 是 props 驱动的列表，
 * 这里把它接到扩展包状态、商店状态单例和各通道，再补上原来页面里的「从文件夹加载」「全部重新加载」、
 * 点一行进详情和 AI 引擎的插件
 */
export function InstalledPage({ initialGroup }: { initialGroup?: PackGroup }) {
  const { t, locale } = useI18n()
  const machines = useMachines()
  const state = usePackState()
  const store = useExtStore()
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const aiRef = useRef<HTMLDivElement>(null)
  const bridge = window.pixelsky?.extpacks

  // 从旧入口（输入框 / 、侧栏插件、命令面板）进来时直接滚到 AI 引擎
  useEffect(() => {
    if (initialGroup !== 'ai') return
    const id = window.setTimeout(() => aiRef.current?.scrollIntoView({ block: 'start' }), 0)
    return () => window.clearTimeout(id)
  }, [initialGroup])

  const selectedPack = selected ? state.packs.find(p => p.key === selected) : undefined

  const run = async <T,>(job: () => Promise<T> | undefined): Promise<T | undefined> => {
    if (busy) return undefined
    setBusy(true)
    setError(null)
    setSummary(null)
    try {
      const out = await job()
      await refreshPacks()
      return out
    } catch (e) {
      setError(errorText(e))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const addFolder = async (): Promise<void> => {
    const added = await run(() => bridge?.addFolder(null))
    if (added) setSelected(added.key)
  }

  // 装 / 更新 / 换回：installExtension 失败不抛错而是把原因记在状态里（显示在对应的行 / 详情上），这里转成抛错好让 runUpdateAll 数失败
  // 提示里要用的名字和种类：这里都是已装的扩展，只会是更新或换回，不会是「已安装」
  const install = async (id: string, version: string, rollback = false): Promise<void> => {
    const pack = state.packs.find(p => p.id === id)
    const name = pack ? packTitle(pack, locale) : undefined
    if (!(await installExtension(id, version, { rollback, kind: 'update', name }))) throw new Error('install failed')
  }

  const updateOne = (pack: ExtPackInfo): void => {
    const latest = pack.id ? store.state.updates[pack.id]?.latest : undefined
    if (pack.id && latest) void run(() => install(pack.id as string, latest).catch(() => undefined))
  }

  return (
    <>
      {selectedPack ? (
        <PackDetail key={selectedPack.key} pack={selectedPack} all={state.packs} onClose={() => setSelected(null)} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button
              icon={FolderPlus}
              disabled={busy}
              data-setting-title={tr('extensions.loadFolder')}
              onClick={() => void addFolder()}
            >
              {t('extensions.loadFolder')}
            </Button>
            <Button icon={RefreshCw} disabled={busy} onClick={() => void run(() => bridge?.reload(null))}>
              {t('extensions.reloadAll')}
            </Button>
          </div>
          <InstalledTab
            packs={state.packs}
            updates={store.state.updates}
            site={store.state.site || null}
            blocklistAt={store.state.blocklistAt}
            now={Date.now()}
            checking={store.checking}
            installingIds={new Set(Object.keys(store.state.installing))}
            busy={busy}
            summary={summary}
            error={error}
            onOpen={setSelected}
            onToggle={(key, on) => void run(() => bridge?.setEnabled(key, on))}
            onCheckUpdates={() => void checkExtUpdates()}
            onUpdateAll={candidates =>
              void run(async () => {
                const r = await runUpdateAll(candidates, store.state.updates, (id, v) => install(id, v))
                setSummary(t('extstore.installed.updateAllDone', r))
              })
            }
            onUpdate={updateOne}
            onRollback={(pack, version) => {
              if (pack.id) void run(() => install(pack.id as string, version, true).catch(() => undefined))
            }}
            onUninstall={pack => void run(() => bridge?.remove(pack.key))}
          />
          <div ref={aiRef}>
            <GroupTitle>{tr('extensions.aiGroup')}</GroupTitle>
            {machines.currentId === 'local' ? (
              <PluginsSection />
            ) : (
              <p className="mt-3 text-ui text-fg-muted">{t('machines.remoteExtensions')}</p>
            )}
          </div>
        </>
      )}
    </>
  )
}
