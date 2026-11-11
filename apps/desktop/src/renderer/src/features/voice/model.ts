// 语音输入的设置和纯逻辑（docs/ui/voice-input.md）：用哪个自定义接口、哪个模型识别；只存在本机
import { useSyncExternalStore } from 'react'
import type { ProviderView } from '../../../../shared/types/providers'

export type VoiceLanguage = 'auto' | 'zh' | 'en'

export interface VoiceSettings {
  /** null：用第一个能转写的接口 */
  providerId: string | null
  model: string
  language: VoiceLanguage
}

export const VOICE_KEY = 'pixelsky.voice'
export const DEFAULT_VOICE: VoiceSettings = { providerId: null, model: 'whisper-1', language: 'auto' }
/** 一次最多录多久（秒），到点自动结束并识别 */
export const VOICE_MAX_SECONDS = 120

export function parseVoiceSettings(raw: unknown): VoiceSettings {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const model = typeof v.model === 'string' ? v.model.trim().slice(0, 200) : ''
  return {
    providerId: typeof v.providerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.providerId) ? v.providerId : null,
    model: model || DEFAULT_VOICE.model,
    language: v.language === 'zh' || v.language === 'en' ? v.language : 'auto',
  }
}

/** 能转写的接口：OpenAI 兼容的两种协议（Anthropic 协议没有 /audio/transcriptions） */
export const voiceProviders = (providers: readonly ProviderView[]): ProviderView[] =>
  providers.filter(p => p.protocol !== 'anthropic')

/** 这次用哪个接口：选过且还在就用它，否则第一个能转写的；一个都没有为 null */
export function voiceTarget(providers: readonly ProviderView[], settings: VoiceSettings): ProviderView | null {
  const usable = voiceProviders(providers)
  return usable.find(p => p.id === settings.providerId) ?? usable[0] ?? null
}

/** 把识别出的文字放到选区（没选中就是光标处）；英文接英文时中间补一个空格 */
export function insertSpoken(text: string, from: number, to: number, spoken: string): { text: string; caret: number } {
  const before = text.slice(0, from)
  const gap = /[A-Za-z0-9.,!?]$/.test(before) && /^[A-Za-z0-9]/.test(spoken) ? ' ' : ''
  return { text: before + gap + spoken + text.slice(to), caret: from + gap.length + spoken.length }
}

/** 录音时长显示成 0:07 */
export const voiceClock = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

function read(): VoiceSettings {
  try {
    return parseVoiceSettings(JSON.parse(localStorage.getItem(VOICE_KEY) ?? '{}'))
  } catch {
    return DEFAULT_VOICE
  }
}
let settings: VoiceSettings = typeof window === 'undefined' ? DEFAULT_VOICE : read()
const listeners = new Set<() => void>()

export function setVoiceSettings(patch: Partial<VoiceSettings>): void {
  settings = parseVoiceSettings({ ...settings, ...patch })
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify(settings))
  } catch {
    /* 存储不可用时，本次仍然生效 */
  }
  listeners.forEach(listener => listener())
}

/** 别的窗口（独立设置窗口）改了设置 */
function onStorage(event: StorageEvent): void {
  if (event.storageArea !== localStorage || (event.key !== VOICE_KEY && event.key !== null)) return
  settings = read()
  listeners.forEach(listener => listener())
}
function subscribe(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', onStorage)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', onStorage)
  }
}
export function useVoiceSettings(): VoiceSettings {
  return useSyncExternalStore(subscribe, () => settings)
}
