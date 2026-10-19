// 设置独立窗口的纯函数部分（docs/ui/settings-window.md §2）：位置和大小对着当前显示器校验、第一次放在主窗口右边，
// 保存下来的偏好、从界面传来的参数检查。不依赖 electron，settings-window.ts 负责真正建窗口。
import type {
  MainWindowAction,
  SettingsHints,
  SettingsTarget,
  SettingsWorkspace,
} from '../../shared/types/settings-window'
import type { WorkspaceRef } from '../../shared/types/workspace'
import { allMessages } from '../../shared/i18n/translate'
import type { Locale } from '../../shared/i18n/messages'
import { MIN_VISIBLE, parseSavedWindowState, type Rect } from './window-bounds'

export const SETTINGS_DEFAULT = { width: 960, height: 700 } as const
export const SETTINGS_MIN = { width: 720, height: 520 } as const

/** 存在 userData/settings-window.json 的偏好 */
export interface SettingsWindowPrefs {
  /** 上次的位置和大小（还原后的，不含最大化）；没存过是 null */
  bounds: Rect | null
  /** 置顶：作为主窗口的子窗口。默认开 */
  pinned: boolean
  /** 记住的打开方式：true 是独立窗口，false 是浮层 */
  preferWindow: boolean
}

export function parseSettingsWindowPrefs(value: unknown): SettingsWindowPrefs {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const saved = parseSavedWindowState(v.bounds)
  return {
    bounds: saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : null,
    pinned: typeof v.pinned === 'boolean' ? v.pinned : true,
    preferWindow: v.preferWindow === true,
  }
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

/** 和 rect 交集最大的那块屏幕（都不相交返回 null） */
function bestDisplay(rect: Rect, displays: Rect[]): Rect | null {
  let best: Rect | null = null
  let bestArea = 0
  for (const d of displays) {
    const o = overlap(rect, d)
    if (o.width * o.height > bestArea) {
      best = d
      bestArea = o.width * o.height
    }
  }
  return best
}

const between = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high)

/** 尺寸收进这块屏幕：不小于最小尺寸（屏幕本身更小时以屏幕为准），不超过屏幕 */
function fitSize(size: { width: number; height: number }, area: Rect): { width: number; height: number } {
  return {
    width: between(size.width, Math.min(SETTINGS_MIN.width, area.width), area.width),
    height: between(size.height, Math.min(SETTINGS_MIN.height, area.height), area.height),
  }
}

/** 放在主窗口右边（顶端对齐）；右边放不下就靠屏幕右缘，和主窗口重叠一部分。没有主窗口时居中 */
export function placeBeside(main: Rect | null, area: Rect, size: { width: number; height: number }): Rect {
  const fit = fitSize(size, area)
  if (!main)
    return {
      ...fit,
      x: area.x + Math.floor((area.width - fit.width) / 2),
      y: area.y + Math.floor((area.height - fit.height) / 2),
    }
  const right = area.x + area.width
  const x = Math.max(area.x, Math.min(main.x + main.width, right - fit.width))
  const y = between(main.y, area.y, area.y + area.height - fit.height)
  return { ...fit, x, y }
}

/**
 * 打开时的位置和大小。
 * - 存过且还有足够的部分在某块屏幕上：沿用，尺寸和位置收进那块屏幕
 * - 没存过，或上次的显示器不在了：放到主窗口右边（尺寸沿用存的，没有就用默认）
 * displays 是各屏幕的 workArea；primary 是主屏的；main 是主窗口现在的位置（没有主窗口是 null）。
 */
export function resolveSettingsBounds(input: {
  saved: Rect | null
  displays: Rect[]
  primary: Rect
  main: Rect | null
}): Rect {
  const { saved, displays, primary, main } = input
  const size = saved ? { width: saved.width, height: saved.height } : SETTINGS_DEFAULT
  if (saved) {
    const area = bestDisplay(saved, displays)
    if (area) {
      const o = overlap(saved, area)
      if (
        o.width >= Math.min(MIN_VISIBLE.width, saved.width) &&
        o.height >= Math.min(MIN_VISIBLE.height, saved.height)
      ) {
        const fit = fitSize(saved, area)
        return {
          ...fit,
          x: between(saved.x, area.x, area.x + area.width - fit.width),
          y: between(saved.y, area.y, area.y + area.height - fit.height),
        }
      }
    }
  }
  const area = (main && bestDisplay(main, displays)) || primary
  return placeBeside(main, area, size)
}

// ---------------------------------------------------------------------------
// 界面传来的参数
// ---------------------------------------------------------------------------

/** 随打开请求带来的「先记一笔」的请求（SettingsHints）：只收认得的字段，每项检查类型和长度，认不出的丢掉 */
export function parseSettingsHints(value: unknown): SettingsHints | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const log = (v.logFocus && typeof v.logFocus === 'object' ? v.logFocus : null) as Record<string, unknown> | null
  const feedback = v.feedback && typeof v.feedback === 'object' && !Array.isArray(v.feedback) ? v.feedback : null
  const hints: SettingsHints = {
    ...(v.modelsScroll === true && { modelsScroll: true as const }),
    ...((v.extTab === 'discover' || v.extTab === 'installed' || v.extTab === 'publish') && { extTab: v.extTab }),
    ...(v.extSearch === true && { extSearch: true as const }),
    ...(typeof v.engineDetail === 'string' && /^[\w-]{1,40}$/.test(v.engineDetail) && { engineDetail: v.engineDetail }),
    ...(str(log?.sessionId, 400) &&
      typeof log.since === 'number' &&
      Number.isFinite(log.since) && {
        logFocus: { sessionId: log.sessionId, since: log.since },
      }),
    // 反馈预填里有出错片段，可能不短；上限放宽，但不能无限大
    ...(feedback && JSON.stringify(feedback).length <= 100_000 && { feedback: feedback as Record<string, unknown> }),
  }
  return Object.keys(hints).length ? hints : undefined
}

/** 分区名：小写字母，和界面里的 SectionId 一致；不认识的由界面忽略 */
export function parseSettingsTarget(section: unknown, row: unknown, hints?: unknown): SettingsTarget {
  const parsed = parseSettingsHints(hints)
  return {
    ...(typeof section === 'string' && /^[a-z]{1,24}$/.test(section) && { section }),
    ...(typeof row === 'string' && row.length > 0 && row.length <= 200 && { row }),
    ...(parsed && { hints: parsed }),
  }
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

/** 设置窗口请主窗口做的事：只收固定的几种，参数逐个检查（设置窗口是应用自己的页面，这里是纵深防御） */
export function parseMainWindowAction(value: unknown): MainWindowAction | null {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  switch (v.kind) {
    case 'manageMachines':
    case 'selectLocalMachine':
      return { kind: v.kind }
    case 'openSession':
      return str(v.sessionId, 200) ? { kind: 'openSession', sessionId: v.sessionId } : null
    case 'openResume':
      return str(v.projectId, 200) && (v.engine === 'claude' || v.engine === 'codex')
        ? { kind: 'openResume', projectId: v.projectId, engine: v.engine }
        : null
    case 'terminalScript':
      return str(v.name, 200) && str(v.command, 2000)
        ? { kind: 'terminalScript', name: v.name, command: v.command }
        : null
    default:
      return null
  }
}

/** 主窗口报来的当前工作区：形状不对返回 null（插件页退回「没有项目」） */
export function parseSettingsWorkspace(value: unknown): SettingsWorkspace | null {
  const v = (value && typeof value === 'object' ? value : null) as Record<string, unknown> | null
  if (!v || !['name', 'path', 'key'].every(k => typeof v[k] === 'string' && (v[k] as string).length <= 4096))
    return null
  const r = (v.ref && typeof v.ref === 'object' ? v.ref : null) as Record<string, unknown> | null
  const folder = Number.isInteger(r?.folder) && (r!.folder as number) >= 1 && (r!.folder as number) <= 20
  const ref: WorkspaceRef | null = str(r?.projectId, 400)
    ? { projectId: r.projectId, ...(folder && { folder: r!.folder as number }) }
    : str(r?.sessionId, 400)
      ? { sessionId: r.sessionId, ...(folder && { folder: r!.folder as number }) }
      : null
  return { ref, name: v.name as string, path: v.path as string, key: v.key as string }
}

/** 窗口标题（系统任务栏、Alt+Tab 里看到的），跟着界面语言 */
export function settingsWindowTitle(locale: Locale): string {
  return allMessages['settingsWindow.title'][locale === 'en-US' ? 'en' : 'zh']
}
