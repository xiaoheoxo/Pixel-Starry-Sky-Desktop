// 内置编辑器的自动保存：按设置在「停止输入一会儿后」「编辑器失去焦点时」「窗口失去焦点时」保存有改动的文件。
// 保存走 files/store 的 saveFile（带版本校验：磁盘上被别处改过时不覆盖，标签页上显示冲突）。
// 什么时候不存见 autoSaveModel.ts 的 autoSaveVerdict；AI 正在跑时先记下，等它停了再存。
import { isDemo } from '@/data'
import { getEngineState, subscribeEngine } from '@/features/engine/store'
import { dirtyFile, getFiles, saveFile, subscribeFiles } from '@/features/files/store'
import { autoSaveVerdict, EDITOR_BLUR_EVENT, getAutoSave, subscribeAutoSave } from './autoSaveModel'

const caseInsensitive = (): boolean => (window.pixelsky?.platform ?? 'win32') !== 'linux'

/** afterDelay 的计时器，和计时时的内容（内容没变就不重新计时） */
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const timedDraft = new Map<string, string>()
/** 自动保存失败时的内容：没再改过就不再试 */
const failed = new Map<string, string>()
/** AI 正在跑而先没存的 */
const waiting = new Set<string>()

function clearTimer(id: string): void {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  timedDraft.delete(id)
}

async function trySave(id: string): Promise<void> {
  if (getAutoSave().mode === 'off' || isDemo) return
  const tab = getFiles().tabs.find(t => t.id === id)
  if (!tab) return
  const verdict = autoSaveVerdict({
    tab,
    dirty: dirtyFile(tab),
    failedDraft: failed.get(id),
    sessions: getEngineState().sessions,
    caseInsensitive: caseInsensitive(),
  })
  if (verdict === 'wait') {
    waiting.add(id)
    return
  }
  waiting.delete(id)
  if (verdict !== 'save') return
  const draft = tab.draft
  if (await saveFile(id)) failed.delete(id)
  else failed.set(id, draft)
}

function saveAll(): void {
  for (const tab of getFiles().tabs) void trySave(tab.id)
}

let lastActive: string | null = null

function onFiles(): void {
  const { tabs, active } = getFiles()
  const mode = getAutoSave().mode
  const open = new Set(tabs.map(t => t.id))
  for (const id of [...timers.keys()]) if (!open.has(id)) clearTimer(id)
  for (const id of [...failed.keys()]) if (!open.has(id)) failed.delete(id)
  for (const id of [...waiting]) if (!open.has(id)) waiting.delete(id)
  // 换了标签页：原来那个编辑器被换走了，不一定收得到 blur，这里补一次
  if (mode === 'onFocusChange' && lastActive && lastActive !== active) void trySave(lastActive)
  lastActive = active
  if (mode !== 'afterDelay') return
  const { delay } = getAutoSave()
  for (const tab of tabs) {
    if (!dirtyFile(tab)) {
      clearTimer(tab.id)
      continue
    }
    if (timedDraft.get(tab.id) === tab.draft) continue
    clearTimer(tab.id)
    timedDraft.set(tab.id, tab.draft)
    timers.set(
      tab.id,
      setTimeout(() => {
        timers.delete(tab.id)
        timedDraft.delete(tab.id)
        void trySave(tab.id)
      }, delay),
    )
  }
}

/** AI 停下来了：之前等着的再试一次（还在跑就继续等） */
function onEngine(): void {
  for (const id of [...waiting]) void trySave(id)
}

function onPrefs(): void {
  if (getAutoSave().mode !== 'afterDelay') for (const id of [...timers.keys()]) clearTimer(id)
  if (getAutoSave().mode === 'off') waiting.clear()
  else onFiles()
}

function onWindowBlur(): void {
  const mode = getAutoSave().mode
  if (mode === 'onFocusChange' || mode === 'onWindowChange') saveAll()
}

function onEditorBlur(e: Event): void {
  if (getAutoSave().mode === 'onFocusChange') void trySave((e as CustomEvent<string>).detail)
}

let started = false

/** 应用启动时调一次 */
export function startAutoSave(): void {
  if (started || typeof window === 'undefined') return
  started = true
  lastActive = getFiles().active
  subscribeFiles(onFiles)
  subscribeEngine(onEngine)
  subscribeAutoSave(onPrefs)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener(EDITOR_BLUR_EVENT, onEditorBlur)
}
