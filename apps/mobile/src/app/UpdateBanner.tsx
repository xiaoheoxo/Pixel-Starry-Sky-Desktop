// 发了新版的横幅（platform/version.ts 发现线上构建号变了才出现）：浮在顶部，不挡下面的操作，点一下刷新。
import { useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { useNewVersion } from '@/platform/version'

export function UpdateBanner() {
  const found = useNewVersion()
  const [dismissed, setDismissed] = useState(false)
  if (!found || dismissed) return null
  return (
    // 外层不接鼠标事件，只有胶囊本身能点；顶部留出刘海
    <div className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-50 flex justify-center px-4 pt-2">
      <div className="fade-in pointer-events-auto flex items-center rounded-full bg-primary text-meta text-primary-fg shadow-popover">
        <button
          type="button"
          onClick={() => location.reload()}
          className="flex min-h-9 items-center gap-1.5 rounded-l-full py-1.5 pr-2 pl-3.5 font-medium active:opacity-70"
        >
          <RefreshCw size={14} aria-hidden /> 有新版本 · 点这里刷新
        </button>
        <button
          type="button"
          aria-label="先不刷新"
          onClick={() => setDismissed(true)}
          className="flex min-h-9 items-center rounded-r-full py-1.5 pr-3 pl-1.5 opacity-80 active:opacity-60"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    </div>
  )
}
