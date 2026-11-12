// 语音识别用的地址和 Key（docs/ui/voice-input.md §10）：主进程加密保存，这里只拿到地址和 Key 的末 4 位
import { useSyncExternalStore } from 'react'
import type { VoiceConfigInput, VoiceConfigView } from '../../../../shared/types/voice'

let config: VoiceConfigView = { baseUrl: '', mode: 'file', keyHint: null, persistent: true }
let started = false
const listeners = new Set<() => void>()

function set(next: VoiceConfigView): void {
  config = next
  listeners.forEach(fn => fn())
}

function read(): void {
  void window.pixelsky?.voice
    ?.get()
    .then(set)
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  if (!started) {
    started = true
    read()
    // 独立的设置窗口里填了地址：回到这个窗口时再读一次，不然麦克风还当没设置
    window.addEventListener('focus', read)
  }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useVoiceConfig = (): VoiceConfigView => useSyncExternalStore(subscribe, () => config)

/** 保存失败（地址格式不对等）抛出主进程给的说明 */
export async function saveVoiceConfig(input: VoiceConfigInput): Promise<void> {
  const api = window.pixelsky?.voice
  if (api) set(await api.save(input))
}
