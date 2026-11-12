// 语音输入的设置和纯逻辑（docs/ui/voice-input.md）：哪个模型识别、什么语言，只存在本机；地址和 Key 在 voiceConfig.ts
import { useSyncExternalStore } from 'react'

export type VoiceLanguage = 'auto' | 'zh' | 'en'

export interface VoiceSettings {
  model: string
  language: VoiceLanguage
}

export const VOICE_KEY = 'pixelsky.voice'
export const DEFAULT_VOICE: VoiceSettings = { model: 'whisper-1', language: 'auto' }
/** 一次最多录多久（秒），到点自动结束并识别 */
export const VOICE_MAX_SECONDS = 120

export function parseVoiceSettings(raw: unknown): VoiceSettings {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const model = typeof v.model === 'string' ? v.model.trim().slice(0, 200) : ''
  return {
    model: model || DEFAULT_VOICE.model,
    language: v.language === 'zh' || v.language === 'en' ? v.language : 'auto',
  }
}

/** 录音统一转成这个采样率的单声道 wav：两种调用方式都收，2 分钟不到 4 MB */
export const VOICE_SAMPLE_RATE = 16000

/** 单声道采样（-1..1）写成 16 位 PCM 的 wav 文件 */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const ascii = (at: number, s: string): void => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  out.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVEfmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, 1, true)
  out.setUint32(24, rate, true)
  out.setUint32(28, rate * 2, true)
  out.setUint16(32, 2, true)
  out.setUint16(34, 16, true)
  ascii(36, 'data')
  out.setUint32(40, samples.length * 2, true)
  samples.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true))
  return out.buffer
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
