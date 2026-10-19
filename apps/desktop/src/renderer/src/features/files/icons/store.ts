import { useSyncExternalStore } from 'react'
import { extText, packName } from '@pixelsky/protocol'
import type { ExtLocale, ExtPackInfo, ExtPackState } from '@pixelsky/protocol'
import { tr } from '@/i18n/core'
import { assetUrl, contributionsFrom, packIdRef } from '@/features/extpacks/model'
import { getPackState, onUiThemeChange, readPackJson, subscribePacks, uiTheme } from '@/features/extpacks/store'
import { languageIdForPath } from '@/features/editor/code/languageIds'
import { buildIconIndex, mergePartial, resolveFileIcon, resolveFolderIcon, type IconIndex } from './resolve'

// 文件图标主题的选择与加载：选项存 localStorage，主题 JSON 经扩展包桥读进来，
// 扩展 / 界面深浅色 / 选项变了就重新解析。导入时不做任何事（node 测试可 import）。

export type IconThemeChoice = 'material' | 'simple' | string // string = 'packId/themeId'
export const ICON_THEME_KEY = 'pixelsky.files.iconTheme'
export const MATERIAL_PACK_ID = 'pixelsky.material-icons'
const MATERIAL_REF = `${MATERIAL_PACK_ID}/material`

export interface FileIconResolver {
  /** 文件名 → 资源地址，没有合适的图标返回 null（调用方画单色图标） */
  file(name: string): string | null
  folder(name: string, expanded: boolean, root?: boolean): string | null
}

const choiceListeners = new Set<() => void>()

export function getIconThemeChoice(): IconThemeChoice {
  try {
    return (typeof localStorage === 'undefined' ? null : localStorage.getItem(ICON_THEME_KEY)) || 'material'
  } catch {
    return 'material'
  }
}

export function setIconThemeChoice(v: IconThemeChoice): void {
  try {
    localStorage.setItem(ICON_THEME_KEY, v)
  } catch {
    /* 存不了就只在本次运行里不变；下面照常通知 */
  }
  for (const l of [...choiceListeners]) l()
}

/**
 * 另一个窗口（比如独立的设置窗口）改了选项：浏览器只在别的窗口发 storage 事件（云同步写回时自己补一个），
 * 收到就当本窗口也改了一次，重新解析、通知订阅者
 */
export function onIconThemeStorage(event: Pick<StorageEvent, 'key' | 'storageArea'>): void {
  if (event.storageArea !== localStorage || (event.key !== ICON_THEME_KEY && event.key !== null)) return
  for (const l of [...choiceListeners]) l()
}

interface ThemeSource {
  pack: ExtPackInfo
  /** 主题 JSON 在扩展里的路径 */
  path: string
}
interface Selection {
  base: ThemeSource
  /** 叠在底板上的局部主题，按扩展顺序 */
  partials: ThemeSource[]
}

function findTheme(state: ExtPackState, ref: string): ThemeSource | null {
  const parsed = packIdRef(ref)
  if (!parsed) return null
  for (const { pack, item } of contributionsFrom(state, 'iconThemes')) {
    if (pack.id === parsed.packId && item.id === parsed.itemId && !item.partial) return { pack, path: item.path }
  }
  return null
}

/** 选项 → 实际用的主题：选的找不到（扩展没了 / 停用了）退回 Material，再退回简单（null） */
export function selectIconTheme(choice: IconThemeChoice, state: ExtPackState): Selection | null {
  if (choice === 'simple') return null
  const base = (choice !== 'material' && findTheme(state, choice)) || findTheme(state, MATERIAL_REF)
  if (!base) return null
  const partials: ThemeSource[] = []
  for (const { pack, item } of contributionsFrom(state, 'iconThemes')) {
    if (item.partial) partials.push({ pack, path: item.path })
  }
  return { base, partials }
}

/** 设置页下拉框该显示哪一项（选的主题已经失效时显示实际生效的那个） */
export function effectiveIconChoice(choice: IconThemeChoice, state: ExtPackState): IconThemeChoice {
  const sel = selectIconTheme(choice, state)
  if (!sel) return 'simple'
  if (choice !== 'material' && choice !== 'simple' && findTheme(state, choice)) return choice
  return 'material'
}

/** 下拉框的选项：Material 扩展启用着才列 Material，「简单」一直在，再加扩展里的完整主题 */
export function iconThemeOptions(
  state: ExtPackState,
  locale: ExtLocale,
): Array<{ value: IconThemeChoice; label: string }> {
  const out: Array<{ value: IconThemeChoice; label: string }> = [
    ...(findTheme(state, MATERIAL_REF) ? [{ value: 'material', label: tr('fileIcons.material') }] : []),
    { value: 'simple', label: tr('fileIcons.simple') },
  ]
  for (const { pack, item } of contributionsFrom(state, 'iconThemes')) {
    if (item.partial || !pack.id || !pack.manifest) continue
    const value = `${pack.id}/${item.id}`
    if (value === MATERIAL_REF) continue
    out.push({ value, label: `${extText(item.label, locale)} (${packName(pack.manifest, locale)})` })
  }
  return out
}

/**
 * 有没有能选的图标主题（Material 或扩展里的完整主题）。都停用了只剩「简单」，设置 › 外观 就不显示「文件图标」这一行；
 * 选过的保留在本机，扩展重新启用后照旧生效
 */
export function iconThemesAvailable(state: ExtPackState): boolean {
  return contributionsFrom(state, 'iconThemes').some(({ item }) => !item.partial)
}

function makeResolver(index: IconIndex, light: boolean): FileIconResolver {
  const memo = new Map<string, string | null>()
  const url = (ref: { packKey: string; revision: number; path: string } | null) =>
    ref ? assetUrl(ref.packKey, ref.path, ref.revision) : null
  const cached = (key: string, make: () => string | null): string | null => {
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    const v = make()
    memo.set(key, v)
    return v
  }
  return {
    file: name =>
      cached('f:' + name, () => {
        // 语言 id 只在名字 / 扩展名都没命中时才用得上，但要先算：languageIdForPath 本身很便宜
        const ref = resolveFileIcon(index, name, { light, languageId: languageIdForPath(name) })
        return url(ref)
      }),
    folder: (name, expanded, root) =>
      cached(`d:${root ? 1 : 0}${expanded ? 1 : 0}:${name}`, () =>
        url(resolveFolderIcon(index, name, { light, expanded, root })),
      ),
  }
}

// ---- 单例：当前解析结果 ----
const listeners = new Set<() => void>()
let current: FileIconResolver | null = null
let currentIndex: IconIndex | null = null
let currentSig = ''
let currentLight = false
let loadSeq = 0
let started = false

const emit = () => {
  for (const l of [...listeners]) l()
}

function reload(): void {
  const sel = selectIconTheme(getIconThemeChoice(), getPackState())
  const sources = sel ? [sel.base, ...sel.partials] : []
  const sig = sources.map(s => `${s.pack.key}@${s.pack.revision}:${s.path}`).join('|')
  if (sig === currentSig && (sig === '' || currentIndex)) {
    // 主题没变；深浅色变了要换一个新的解析器对象，让用到它的组件重画
    const light = uiTheme() === 'light'
    if (currentIndex && light !== currentLight) {
      currentLight = light
      current = makeResolver(currentIndex, light)
      emit()
    }
    return
  }
  const seq = ++loadSeq
  if (!sel) {
    currentSig = sig
    currentIndex = null
    current = null
    emit()
    return
  }
  void Promise.all(
    sources.map(async (s, i) => {
      try {
        const json = await readPackJson(s.pack.key, s.path)
        return buildIconIndex(json, { packKey: s.pack.key, revision: s.pack.revision, themePath: s.path }).index
      } catch {
        // 局部主题读不出来就跳过；底板读不出来整体退回简单图标
        return i === 0 ? 'fail' : null
      }
    }),
  ).then(parts => {
    if (seq !== loadSeq) return
    currentSig = sig
    if (parts[0] === 'fail' || parts[0] === null) {
      currentIndex = null
      current = null
    } else {
      let index = parts[0]
      for (const p of parts.slice(1)) if (p && p !== 'fail') index = mergePartial(index, p)
      currentIndex = index
      currentLight = uiTheme() === 'light'
      current = makeResolver(index, currentLight)
    }
    emit()
  })
}

function start(): void {
  if (started || typeof window === 'undefined') return
  started = true
  subscribePacks(reload)
  onUiThemeChange(reload)
  choiceListeners.add(reload)
  watchStorage()
  reload()
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** null = 简单图标 / 还没加载好 */
export function useFileIconResolver(): FileIconResolver | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}

let storageWatched = false
function watchStorage(): void {
  if (storageWatched || typeof window === 'undefined') return
  storageWatched = true
  window.addEventListener('storage', onIconThemeStorage)
}

export function subscribeIconThemeChoice(l: () => void): () => void {
  watchStorage()
  choiceListeners.add(l)
  return () => {
    choiceListeners.delete(l)
  }
}

/** 选项变化时重画（设置页用） */
export function useIconThemeChoice(): IconThemeChoice {
  return useSyncExternalStore(subscribeIconThemeChoice, getIconThemeChoice, () => 'material')
}
