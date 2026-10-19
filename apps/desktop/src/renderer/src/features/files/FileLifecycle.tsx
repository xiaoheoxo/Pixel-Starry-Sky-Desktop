import { tr } from '../../i18n/core'
import { useEffect } from 'react'
import { useEngineState } from '@/features/engine'
import { usePaneState } from '@/features/panes/store'
import { isFileTab, leaves } from '@/features/panes/tree'
import { activateFile, checkOpenFiles, ensureFile, getFiles, hasDirtyFiles, refreshActiveHead } from './store'
import { confirmFiles } from './FileConfirm'

export function FileLifecycle() {
  const layout = usePaneState(s => s.layout)
  const snapshots = useEngineState(s => s.snapshots)
  const changeKey = Object.values(snapshots)
    .flatMap(s => s.items.filter(i => i.kind === 'file_change').map(i => `${i.id}:${i.status}`))
    .join('|')
  useEffect(() => {
    for (const tab of leaves(layout.root)
      .flatMap(l => l.tabs)
      .filter(isFileTab))
      void ensureFile(tab)
    const tab = leaves(layout.root).find(l => l.id === layout.focused)?.active
    if (tab && isFileTab(tab)) activateFile(tab)
  }, [layout])
  useEffect(() => {
    checkOpenFiles()
  }, [changeKey])
  useEffect(() => {
    window.addEventListener('focus', checkOpenFiles)
    // 在终端里提交过：正在看的标签的「变更」基准跟上新的 HEAD
    window.addEventListener('focus', refreshActiveHead)
    const before = (e: BeforeUnloadEvent): void => {
      if (hasDirtyFiles()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', before)
    const unsubscribe = window.pixelsky?.files.onBeforeClose(() => {
      void confirmFiles(
        getFiles().tabs.map(t => t.id),
        tr('files.FileConfirm.quitApplication'),
      ).then(ok => {
        if (ok) void window.pixelsky!.files.finishClose()
      })
    })
    return () => {
      window.removeEventListener('focus', checkOpenFiles)
      window.removeEventListener('focus', refreshActiveHead)
      window.removeEventListener('beforeunload', before)
      unsubscribe?.()
    }
  }, [])
  return null
}
