// 引擎授权登录的进度（docs/ui/model-channels.md §3）：主进程推 engine_login，这里按引擎记最新一条。
// 演示模式走假流程：出网址 → 等一会儿 → 授权成功，并把演示引擎改成已授权（只在内存里）
import { useSyncExternalStore } from 'react'
import type { EngineId, EngineLogin } from '@pixelsky/protocol'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import type { EngineLite } from '@/data/types'
import { bridge, useEngineState } from '@/features/engine/store'
import { demoAddAccount } from './accountsStore'

let logins: Partial<Record<EngineId, EngineLogin>> = {}
/** 演示模式里假授权 / 取消授权过的引擎 */
let demoAuth: Partial<Record<EngineId, boolean>> = {}
let demoEngines: EngineLite[] | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(fn => fn())
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function put(login: EngineLogin): void {
  logins = { ...logins, [login.engine]: login }
  emit()
}

/** 这次授权已经收到过主进程推来的进度：调用的返回值可能比推送晚到，不能再拿它盖掉更新的状态 */
const pushed = new Set<EngineId>()
let listening = false
function listen(): void {
  if (listening || !bridge) return
  listening = true
  bridge.onEvent(e => {
    if (e.kind !== 'engine_login') return
    pushed.add(e.login.engine)
    put(e.login)
  })
}

export function useEngineLogin(engine: EngineId): EngineLogin | null {
  return useSyncExternalStore(subscribe, () => logins[engine] ?? null)
}

export const loginRunning = (l: EngineLogin | null | undefined): boolean =>
  !!l && l.phase !== 'done' && l.phase !== 'failed' && l.phase !== 'cancelled'

const blank = (engine: EngineId, method: EngineLogin['method'], target?: string): EngineLogin => ({
  engine,
  method,
  phase: 'starting',
  startedAt: Date.now(),
  url: null,
  userCode: null,
  awaitingCode: false,
  line: null,
  error: null,
  ...(target ? { target } : {}),
})

const demoTimers = new Map<EngineId, number[]>()
function demoFlow(engine: EngineId, method: EngineLogin['method'], target?: string): void {
  demoTimers.get(engine)?.forEach(t => clearTimeout(t))
  const step = (ms: number, fn: () => void): number => window.setTimeout(fn, ms)
  const url =
    method === 'device'
      ? 'https://auth.openai.com/codex/device'
      : engine === 'claude'
        ? 'https://claude.com/cai/oauth/authorize?code=true&demo=1'
        : 'https://auth.openai.com/oauth/authorize?demo=1'
  put(blank(engine, method, target))
  demoTimers.set(engine, [
    step(400, () =>
      put({
        ...logins[engine]!,
        phase: 'waiting',
        url,
        userCode: method === 'device' ? 'WHYJ-RGMV5' : null,
        awaitingCode: engine === 'claude',
      }),
    ),
    step(6000, () => {
      if (!loginRunning(logins[engine])) return
      put({ ...logins[engine]!, phase: 'verify', awaitingCode: false })
    }),
    step(6800, () => {
      if (logins[engine]?.phase !== 'verify') return
      if (target === 'add' && (engine === 'codex' || engine === 'claude')) demoAddAccount(engine)
      else if (!target) {
        demoAuth = { ...demoAuth, [engine]: true }
        demoEngines = null
      }
      put({ ...logins[engine]!, phase: 'done' })
    }),
  ])
}

/**
 * 开始授权；同一个引擎已经在授权就接着用那一次。
 * target：订阅账号多开（docs/ui/engine-accounts.md）——'add' 添加账号，账号 id 是重新登录那个账号；不传是当前账号
 */
export async function startLogin(
  engine: EngineId,
  method: EngineLogin['method'] = 'browser',
  target?: string,
): Promise<void> {
  const now = logins[engine]
  if (loginRunning(now) && now!.method === method && now!.target === target) return
  if (isDemo) {
    demoFlow(engine, method, target)
    return
  }
  if (!bridge) return
  listen()
  // 换了方式（浏览器 ↔ 设备码）或换了账号：先停掉上一次
  if (loginRunning(now)) await bridge.cancelLogin(engine).catch(() => undefined)
  put(blank(engine, method, target))
  pushed.delete(engine)
  try {
    const first =
      target === 'add'
        ? await bridge.addAccount(engine, method)
        : target
          ? await bridge.reloginAccount(engine, target, method)
          : await bridge.loginEngine(engine, method)
    if (!pushed.has(engine)) put(first)
  } catch (err) {
    put({ ...blank(engine, method, target), phase: 'failed', error: (err as Error).message })
  }
}

export async function sendLoginCode(engine: EngineId, code: string): Promise<void> {
  if (isDemo) {
    if (logins[engine]) put({ ...logins[engine]!, awaitingCode: false, phase: 'verify' })
    demoTimers.get(engine)?.forEach(t => clearTimeout(t))
    demoTimers.set(engine, [
      window.setTimeout(() => {
        demoAuth = { ...demoAuth, [engine]: true }
        demoEngines = null
        if (logins[engine]) put({ ...logins[engine]!, phase: 'done' })
      }, 800),
    ])
    return
  }
  await bridge?.loginInput(engine, code)
}

export async function cancelLogin(engine: EngineId): Promise<void> {
  if (isDemo) {
    demoTimers.get(engine)?.forEach(t => clearTimeout(t))
    if (logins[engine]) put({ ...logins[engine]!, phase: 'cancelled', awaitingCode: false })
    return
  }
  if (!loginRunning(logins[engine])) return
  await bridge?.cancelLogin(engine)
}

/** 关弹窗后忘掉已经结束的那次（下次打开从头开始） */
export function clearLogin(engine: EngineId): void {
  if (loginRunning(logins[engine])) return
  const { [engine]: _gone, ...rest } = logins
  logins = rest
  emit()
}

/** 取消授权；返回失败原因（成功为 null） */
export async function logoutEngine(engine: EngineId): Promise<string | null> {
  if (isDemo) {
    demoAuth = { ...demoAuth, [engine]: false }
    demoEngines = null
    emit()
    return null
  }
  if (!bridge) return null
  try {
    const r = await bridge.logoutEngine(engine)
    return r.ok ? null : r.output || null
  } catch (err) {
    return (err as Error).message
  }
}

function demoEngineList(): EngineLite[] {
  if (demoEngines) return demoEngines
  demoEngines = demo().engines.status.map(e => {
    const signed = demoAuth[e.id]
    if (signed === undefined || (e.status !== 'ready' && e.status !== 'unauthenticated')) return e
    return signed
      ? {
          ...e,
          status: 'ready',
          message: null,
          account: e.account ?? { email: 'linxia@example.com', plan: e.id === 'codex' ? 'plus' : 'max' },
          auth: { kind: 'login' as const },
        }
      : { ...e, status: 'unauthenticated', account: undefined }
  })
  return demoEngines
}

/** 通道要看的引擎列表：真实模式是检测结果，演示模式是演示引擎（带假授权的结果） */
export function useChannelEngines(): EngineLite[] {
  const live = useEngineState(s => s.engines)
  const demoList = useSyncExternalStore(subscribe, () => (isDemo ? demoEngineList() : null))
  return demoList ?? live
}
