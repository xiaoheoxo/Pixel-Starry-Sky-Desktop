// 设置云同步的白名单（docs/ui/settings-sync.md §3）：只同步这里列出的键，不把 localStorage 整个传上去。
// localStorage 里的设置按原样的文本同步（值是字符串），写回本机后由各设置模块自己的读取函数校验，不合法的回到默认值；
// 引擎设置和外部编辑器的窗口方式在主进程，经 settingsSync / editor 桥接读写。
export type SyncCategory = 'appearance' | 'display' | 'notifications' | 'keybindings' | 'platform' | 'engine'
export const SYNC_CATEGORIES: readonly SyncCategory[] = [
  'appearance',
  'display',
  'notifications',
  'keybindings',
  'platform',
  'engine',
]

export interface SyncEntry {
  key: string
  category: SyncCategory
  /** localStorage 里的键（这类设置的写入由 engine.ts 监听，2 秒后触发同步） */
  storage?: string
  /** 读本机现在的值；undefined 表示没有（默认值） */
  read(): Promise<unknown>
  /** 写回本机；null 表示恢复默认 */
  write(value: unknown): Promise<void>
}

/** 一个值最多 64 KB（和云端的防护一致） */
const MAX = 64 * 1024

function storageEntry(
  key: string,
  category: SyncCategory,
  storage: string,
  transform?: { out(raw: string): string | null; in(raw: string, current: string | null): string | null },
): SyncEntry {
  return {
    key,
    category,
    storage,
    read: async () => {
      const raw = localStorage.getItem(storage)
      if (raw === null) return undefined
      return (transform ? transform.out(raw) : raw) ?? undefined
    },
    write: async value => {
      const old = localStorage.getItem(storage)
      let next: string | null = null
      if (typeof value === 'string' && value.length <= MAX) next = transform ? transform.in(value, old) : value
      else if (value !== null) return // 不是这台电脑认得的格式：保留本机的
      if (next === old) return
      if (next === null) localStorage.removeItem(storage)
      else localStorage.setItem(storage, next)
      // 本窗口的设置模块靠 storage 事件重新读取（其他窗口浏览器会自己发）
      window.dispatchEvent(
        new StorageEvent('storage', { key: storage, oldValue: old, newValue: next, storageArea: localStorage }),
      )
    },
  }
}

/** 通知：不同步一次性的「勿扰到某时」（dndUntil），写回时保留本机的 */
const withoutDnd = {
  out(raw: string): string | null {
    try {
      const v = JSON.parse(raw) as Record<string, unknown>
      return JSON.stringify({ ...v, dndUntil: null })
    } catch {
      return null
    }
  },
  in(raw: string, current: string | null): string | null {
    try {
      const mine = current ? (JSON.parse(current) as { dndUntil?: unknown }) : {}
      return JSON.stringify({ ...(JSON.parse(raw) as object), dndUntil: mine.dndUntil ?? null })
    } catch {
      return null
    }
  },
}

/** 引擎设置一次读三项：同一轮同步里只调一次主进程 */
let engineRead: Promise<Record<string, unknown> | null> | null = null
export function resetEngineRead(): void {
  engineRead = null
}
function engineEntry(key: string): SyncEntry {
  return {
    key,
    category: 'engine',
    read: async () => {
      engineRead ??= window.pixelsky?.settingsSync.engine() ?? Promise.resolve(null)
      const all = await engineRead
      return all ? all[key] : undefined
    },
    write: async value => {
      await window.pixelsky?.settingsSync.applyEngine(key, value)
      engineRead = null
    },
  }
}

export const SYNC_ENTRIES: readonly SyncEntry[] = [
  // 外观
  storageEntry('desktop.theme', 'appearance', 'pixelsky.theme'),
  storageEntry('desktop.palette', 'appearance', 'pixelsky.palette'),
  storageEntry('desktop.accent', 'appearance', 'pixelsky.accent'),
  storageEntry('desktop.motion', 'appearance', 'pixelsky.motion'),
  storageEntry('desktop.paneFocusMotion', 'appearance', 'pixelsky.paneFocusMotion'),
  storageEntry('desktop.minimal', 'appearance', 'pixelsky.minimal'),
  storageEntry('desktop.modeTransition', 'appearance', 'pixelsky.mode-transition'),
  storageEntry('desktop.gitOpenStyle', 'appearance', 'pixelsky.coding.git-open'),
  storageEntry('desktop.locale', 'appearance', 'pixelsky.locale'),
  storageEntry('desktop.fonts', 'appearance', 'pixelsky.fonts'),
  storageEntry('desktop.sidebar', 'appearance', 'pixelsky.sidebar'),
  // 对话显示
  storageEntry('desktop.composerStyle', 'display', 'pixelsky.composer-style'),
  storageEntry('desktop.replyStats', 'display', 'pixelsky.reply-stats'),
  storageEntry('desktop.turnRail', 'display', 'pixelsky.turn-rail'),
  storageEntry('desktop.longConversation', 'display', 'pixelsky.long-conversation'),
  storageEntry('desktop.subagentView', 'display', 'pixelsky.subagent-view'),
  storageEntry('desktop.stopBackgroundSubagents', 'display', 'pixelsky.stop-background-subagents'),
  storageEntry('desktop.messageActions', 'display', 'pixelsky.message-actions'),
  storageEntry('desktop.cacheMissAlert', 'display', 'pixelsky.cache-miss-alert'),
  storageEntry('desktop.rewindConfirmSkip', 'display', 'pixelsky.rewind-confirm-skip'),
  storageEntry('desktop.editorWrap', 'display', 'pixelsky.editor.wrap'),
  storageEntry('desktop.editorAutoSave', 'display', 'pixelsky.editor.autoSave'),
  storageEntry('desktop.diffMode', 'display', 'pixelsky.git.diffMode'),
  storageEntry('desktop.usageChart', 'display', 'pixelsky.usage-chart'),
  {
    key: 'desktop.editor.window',
    category: 'display',
    read: async () => (await window.pixelsky?.editor.state())?.window,
    write: async value => {
      if (value === 'reuse' || value === 'new' || value === null)
        await window.pixelsky?.editor.preferences({ window: value ?? 'reuse' })
    },
  },
  // 通知
  storageEntry('desktop.notifications', 'notifications', 'pixelsky.notifications.v1', withoutDnd),
  // 快捷键
  storageEntry('desktop.keybindings', 'keybindings', 'pixelsky.keybindings'),
  // 模型与线路（线路随账号走；线路不再公开时沿用「不可用就回到默认」）
  storageEntry('desktop.platform.claude', 'platform', 'pixelsky.platform.preference.v1'),
  storageEntry('desktop.platform.codex', 'platform', 'pixelsky.sources.v2'),
  storageEntry('desktop.platform.hiddenModels', 'platform', 'pixelsky.platform.hiddenModels'),
  storageEntry('desktop.channels.executor', 'platform', 'pixelsky.channels.executor.v1'),
  storageEntry('desktop.channels.newTask', 'platform', 'pixelsky.channels.newTask.v1'),
  storageEntry('desktop.channels.menuLayout', 'platform', 'pixelsky.channels.menuLayout.v1'),
  // AI 写提交信息的写法（docs/ui/ai-commit-codex-warnings-history.md §2.3）；用哪里的模型只在本机
  storageEntry('desktop.aiCommit.writing', 'platform', 'pixelsky.aiCommit.writing'),
  // 引擎（只读写本机的引擎设置；命令路径、参数、环境变量出不去，见主进程 settings:engine）
  engineEntry('desktop.engine.defaults'),
  engineEntry('desktop.engine.options'),
  engineEntry('desktop.engine.retries'),
]

/** localStorage 键 → 白名单里的设置（engine.ts 监听写入用） */
export const STORAGE_KEYS = new Set(SYNC_ENTRIES.flatMap(e => (e.storage ? [e.storage] : [])))
