import { dotError } from './errors'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize, Monitor, RefreshCw, X } from 'lucide-react'
import { Button, IconButton, Spinner } from '@/ui'
import { tr, translateMessage } from '@/i18n/core'
import { dotKeysym, keyPacket, pointerPacket, videoPoint } from './computerInput'
import { useDotKey } from './context'

type Mode = 'observing' | 'requesting' | 'controlling'
interface Connection {
  channel: RTCDataChannel
  mode: Mode
  peer?: string
  request?: string
  requestTimeout?: number
  keys: Map<string, number>
  buttons: Set<number>
}

export function DotComputer({ onClose }: { onClose: () => void }) {
  const key = useDotKey()
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<'connecting' | 'ready' | 'failed'>('connecting')
  const [mode, setMode] = useState<Mode>('observing')
  const [error, setError] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const live = useRef<Connection | null>(null)
  const release = useCallback((notify = true) => {
    const c = live.current
    if (!c) return
    clearTimeout(c.requestTimeout)
    if (c.channel.readyState === 'open') {
      for (const key of c.keys.values()) c.channel.send(keyPacket(false, key))
      for (const button of c.buttons) c.channel.send(keyPacket(false, button))
      if (notify && c.mode !== 'observing') c.channel.send(JSON.stringify({ event: 'control/release' }))
    }
    c.keys.clear()
    c.buttons.clear()
    c.request = undefined
    c.mode = 'observing'
    setMode('observing')
  }, [])
  useEffect(() => {
    let gone = false
    const pc = new RTCPeerConnection()
    pc.addTransceiver('audio', { direction: 'inactive' })
    pc.addTransceiver('video', { direction: 'recvonly' })
    const channel = pc.createDataChannel('')
    const connection: Connection = { channel, mode: 'observing', keys: new Map(), buttons: new Set() }
    live.current = connection
    setMode('observing')
    setStatus('connecting')
    setError('')
    const fail = (e: unknown) => {
      if (gone) return
      clearTimeout(timer)
      release()
      setStatus('failed')
      setError(dotError(e))
      pc.close()
    }
    const ready = () => {
      if (!gone && channel.readyState === 'open' && video.current?.readyState && video.current.readyState >= 2) {
        clearTimeout(timer)
        setStatus('ready')
      }
    }
    const timer = window.setTimeout(() => fail(new Error(tr('dot.computerTimeout'))), 30_000)
    pc.ontrack = event => {
      if (gone || event.track.kind !== 'video' || !video.current) return
      video.current.srcObject = event.streams[0] ?? new MediaStream([event.track])
      video.current.play().catch(fail)
    }
    pc.onconnectionstatechange = () => {
      if (!gone && pc.connectionState === 'failed') fail(new Error(tr('dot.computerDisconnected')))
    }
    channel.onopen = ready
    channel.onclose = () => {
      if (!gone && pc.connectionState !== 'closed') fail(new Error(tr('dot.computerDisconnected')))
    }
    channel.onerror = () => fail(new Error(tr('dot.computerDisconnected')))
    channel.onmessage = event => {
      if (gone || typeof event.data !== 'string') return
      let message: Record<string, unknown>
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (!message || typeof message !== 'object') return
      if (message.event === 'system/init' || message.event === 'signal/provide') {
        const peer = message.session_id ?? message.id
        if (typeof peer === 'string') connection.peer = peer
      }
      if (
        message.event === 'control/locked' &&
        message.id === connection.peer &&
        connection.request &&
        (!('request_id' in message) || message.request_id === connection.request)
      ) {
        connection.request = undefined
        connection.mode = 'controlling'
        clearTimeout(connection.requestTimeout)
        setMode('controlling')
        video.current?.focus()
      }
      if (message.event === 'control/release' && message.id === connection.peer) release(false)
    }
    const element = video.current
    element?.addEventListener('playing', ready)
    void (async () => {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const answer = await window.pixelsky!.dotChat.computerOffer(key, offer.sdp!)
      if (!gone) await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    })().catch(fail)
    const blur = () => {
      if (live.current?.mode !== 'observing') release()
    }
    const hidden = () => {
      if (document.hidden) blur()
    }
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      gone = true
      clearTimeout(timer)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', hidden)
      element?.removeEventListener('playing', ready)
      release()
      live.current = null
      pc.close()
      if (element) {
        element.srcObject = null
      }
    }
  }, [key, attempt, release])
  const move = (event: React.PointerEvent<HTMLVideoElement> | React.WheelEvent<HTMLVideoElement>) => {
    const c = live.current
    const el = video.current
    if (c?.mode !== 'controlling' || c.channel.readyState !== 'open' || !el) return false
    const rect = el.getBoundingClientRect()
    const point = videoPoint(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
      el.videoWidth,
      el.videoHeight,
    )
    if (!point) return false
    c.channel.send(pointerPacket('move', point.x, point.y))
    return true
  }
  return (
    <section className="dot-computer" aria-label={tr('dot.computer')} ref={area}>
      <header className="dot-toolbar">
        <Monitor size={17} />
        <h2 className="min-w-0 flex-1 truncate text-ui font-medium">{tr('dot.computer')}</h2>
        <IconButton
          icon={RefreshCw}
          label={tr('dot.refreshConversation')}
          size={32}
          onClick={() => setAttempt(v => v + 1)}
        />
        <IconButton
          icon={Maximize}
          label={tr('dot.fullscreen')}
          size={32}
          onClick={() =>
            void (document.fullscreenElement ? document.exitFullscreen() : area.current?.requestFullscreen())
          }
        />
        <IconButton icon={X} label={tr('dot.closeComputer')} size={32} onClick={onClose} />
      </header>
      <div className="dot-computer-stage">
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          tabIndex={0}
          className="dot-computer-video"
          aria-label={tr('dot.computerDisplay')}
          onContextMenu={e => e.preventDefault()}
          onBlur={e => {
            if (!area.current?.contains(e.relatedTarget)) release()
          }}
          onPointerMove={move}
          onPointerDown={e => {
            if (move(e)) {
              e.preventDefault()
              e.currentTarget.focus()
              e.currentTarget.setPointerCapture(e.pointerId)
              const key = e.button + 1
              live.current!.buttons.add(key)
              live.current!.channel.send(keyPacket(true, key))
            }
          }}
          onPointerUp={e => {
            const c = live.current
            const key = e.button + 1
            if (c?.buttons.delete(key) && c.channel.readyState === 'open') c.channel.send(keyPacket(false, key))
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
          }}
          onPointerCancel={() => release()}
          onWheel={e => {
            if (move(e)) {
              e.preventDefault()
              live.current!.channel.send(pointerPacket('wheel', e.deltaX, e.deltaY))
            }
          }}
          onKeyDown={e => {
            const c = live.current
            if (c?.mode !== 'controlling' || c.channel.readyState !== 'open') return
            if (e.key === 'Escape') {
              e.preventDefault()
              release()
              return
            }
            const key = dotKeysym(e.key)
            if (key !== null) {
              e.preventDefault()
              c.keys.set(e.code, key)
              c.channel.send(keyPacket(true, key))
            }
          }}
          onKeyUp={e => {
            const c = live.current
            const key = c?.keys.get(e.code)
            if (c && key !== undefined && c.channel.readyState === 'open') {
              e.preventDefault()
              c.channel.send(keyPacket(false, key))
              c.keys.delete(e.code)
            }
          }}
        />
        {status === 'connecting' && (
          <div className="dot-computer-overlay">
            <Spinner />
            <p>{tr('dot.computerConnecting')}</p>
          </div>
        )}
        {status === 'failed' && (
          <div className="dot-computer-overlay">
            <p role="alert">{translateMessage(error)}</p>
            <Button icon={RefreshCw} onClick={() => setAttempt(v => v + 1)}>
              {tr('modelChannels.action.retry')}
            </Button>
          </div>
        )}
      </div>
      <footer className="dot-computer-controls">
        <span role="status">
          {tr(
            mode === 'controlling'
              ? 'dot.youControl'
              : mode === 'requesting'
                ? 'dot.controlRequesting'
                : 'dot.dotControls',
          )}
        </span>
        <Button
          disabled={status !== 'ready'}
          onClick={() => {
            const c = live.current
            if (!c || c.channel.readyState !== 'open') return
            if (c.mode !== 'observing') {
              release()
              return
            }
            c.request = crypto.randomUUID()
            c.mode = 'requesting'
            setMode('requesting')
            c.channel.send(JSON.stringify({ event: 'control/request', request_id: c.request }))
            c.requestTimeout = window.setTimeout(() => {
              release()
              setError(tr('dot.controlTimeout'))
            }, 10_000)
          }}
        >
          {tr(mode === 'observing' ? 'dot.takeControl' : 'dot.returnControl')}
        </Button>
        <span className="text-label text-fg-faint">{tr('dot.controlHint')}</span>
        {status === 'ready' && error && (
          <span role="alert" className="text-meta text-warn">
            {translateMessage(error)}
          </span>
        )}
      </footer>
    </section>
  )
}
