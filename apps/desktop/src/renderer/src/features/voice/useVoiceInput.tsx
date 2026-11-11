// 语音输入（docs/ui/voice-input.md）：点一下开始录，再点结束并识别，Esc 取消；识别在主进程里发到用户的自定义接口
import { useEffect, useRef, useState } from 'react'
import { Mic } from 'lucide-react'
import { Spinner, cn } from '@/ui'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { useProviders } from '@/features/account/providers'
import { VOICE_MAX_SECONDS, useVoiceSettings, voiceClock, voiceTarget } from './model'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

interface Handlers {
  /** 识别出的文字（不为空） */
  onText(text: string): void
  /** 出错的说明；开始新的一次时传 null 清掉 */
  onError(message: string | null): void
  /** 还没有能转写的接口 */
  onSetup(): void
}

interface Recording {
  recorder: MediaRecorder
  /** 结束后不识别（取消、组件卸载） */
  discard: boolean
}

export function useVoiceInput(handlers: Handlers) {
  const settings = useVoiceSettings()
  const providers = useProviders()
  const target = voiceTarget(providers.providers, settings)
  const [state, setState] = useState<VoiceState>('idle')
  const [seconds, setSeconds] = useState(0)
  const recording = useRef<Recording | null>(null)
  /** 在等麦克风权限：这期间再点不重复开 */
  const starting = useRef(false)
  /** 正在等的那次识别；取消就换号，晚到的结果不认 */
  const job = useRef(0)
  const alive = useRef(true)
  const latest = useRef({ handlers, target, settings })
  latest.current = { handlers, target, settings }

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      job.current++
      const r = recording.current
      if (r) {
        r.discard = true
        r.recorder.stop()
      }
    }
  }, [])

  const transcribe = async (blob: Blob): Promise<void> => {
    const { target: provider, settings: s } = latest.current
    if (!provider) return setState('idle')
    const id = ++job.current
    setState('transcribing')
    try {
      const text = await window.pixelsky!.providers.transcribe({
        providerId: provider.id,
        model: s.model,
        mime: blob.type,
        audio: await blob.arrayBuffer(),
        language: s.language === 'auto' ? null : s.language,
      })
      if (job.current !== id) return
      // 回调等结果回来再取：识别期间在输入框里打的字在新的那份回调里，用发请求前的那份会把它冲掉
      const h = latest.current.handlers
      if (text) h.onText(text)
      else h.onError(tr('voice.empty'))
    } catch (e) {
      if (job.current === id)
        latest.current.handlers.onError(tr('voice.failed', { error: (e as Error)?.message ?? '' }))
    } finally {
      if (job.current === id && alive.current) setState('idle')
    }
  }

  const start = async (): Promise<void> => {
    if (starting.current) return
    starting.current = true
    const { handlers: h } = latest.current
    h.onError(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      starting.current = false
      const name = (e as Error)?.name
      h.onError(
        name === 'NotFoundError' ? tr('voice.noMic') : tr('voice.denied', { error: (e as Error)?.message ?? name }),
      )
      return
    }
    starting.current = false
    const release = (): void => stream.getTracks().forEach(track => track.stop())
    if (!alive.current) return release()
    const recorder = new MediaRecorder(stream)
    const chunks: Blob[] = []
    const current: Recording = { recorder, discard: false }
    const began = Date.now()
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - began) / 1000)
      setSeconds(elapsed)
      if (elapsed >= VOICE_MAX_SECONDS && recorder.state === 'recording') recorder.stop()
    }, 250)
    recorder.ondataavailable = event => {
      if (event.data.size) chunks.push(event.data)
    }
    recorder.onstop = () => {
      window.clearInterval(timer)
      release()
      if (recording.current === current) recording.current = null
      if (current.discard) {
        if (alive.current) setState('idle')
        return
      }
      void transcribe(new Blob(chunks, { type: recorder.mimeType }))
    }
    recorder.start()
    recording.current = current
    setSeconds(0)
    setState('recording')
  }

  /** 录音中：丢掉不识别；识别中：不等结果了 */
  const cancel = (): void => {
    const r = recording.current
    if (r) {
      r.discard = true
      r.recorder.stop()
    } else if (state === 'transcribing') {
      job.current++
      setState('idle')
    }
  }

  // 录音或识别期间 Esc 取消，焦点在哪都算：用鼠标点了麦克风以后焦点在按钮上，输入框收不到这次按键。
  // 在捕获阶段拦下，不让同一次 Esc 再去停掉正在跑的回复
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  useEffect(() => {
    if (state === 'idle') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      cancelRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state])

  /** 麦克风按钮：没录就开始，录着就结束并识别，识别中就取消 */
  const toggle = (): void => {
    if (state === 'recording') recording.current?.recorder.stop()
    else if (state === 'transcribing') cancel()
    else if (!latest.current.target) latest.current.handlers.onSetup()
    else void start()
  }

  return { state, seconds, toggle, cancel }
}

export type VoiceInput = ReturnType<typeof useVoiceInput>

/** 麦克风按钮：录音中是红点 + 时长，识别中转圈 */
export function VoiceButton({ voice, size = 32 }: { voice: VoiceInput; size?: number }) {
  useI18n()
  const { state } = voice
  const label = tr(state === 'recording' ? 'voice.stop' : state === 'transcribing' ? 'voice.cancel' : 'voice.start')
  return (
    <button
      type="button"
      data-voice={state}
      aria-label={label}
      aria-pressed={state === 'recording'}
      title={label}
      onClick={voice.toggle}
      style={{ height: size, minWidth: size }}
      className={cn(
        'press no-drag inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-fg-muted hover:bg-hover hover:text-fg',
        state === 'recording' && 'px-1.5 text-danger hover:text-danger',
      )}
    >
      {state === 'recording' ? (
        <>
          <span className="size-2 animate-pulse rounded-full bg-danger" />
          <span className="text-meta tabular-nums">{voiceClock(voice.seconds)}</span>
        </>
      ) : state === 'transcribing' ? (
        <Spinner size={14} />
      ) : (
        <Mic size={16} strokeWidth={1.5} />
      )}
    </button>
  )
}
