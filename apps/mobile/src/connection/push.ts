// 锁屏提醒：网页推送（docs/mobile-remote.md §22.2）。手机在云端登记推送订阅（每台配对的电脑各一个设备，各登记一次），
// 电脑有任务等你处理 / 完成 / 出错时经云端推过来，service worker（public/sw.js）显示通知。
// 推送内容只有种类和数量，不带任务标题。只在网页版、正式构建、https 下可用；安卓 App 里不显示这一项。
import { fromBase64Url } from '@pixelsky/link'
import { inApp } from '@/platform'
import { isStandalone } from '@/platform/pwa'
import type { Pairing } from './storage'

/** unsupported：浏览器不支持；install：iPhone / iPad 要先添加到主屏幕；denied：系统里拒绝了通知 */
export type PushState = 'unsupported' | 'install' | 'denied' | 'off' | 'on'

const KEY = 'pixelsky.mobile.push'

const isApple = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

function supported(): boolean {
  return (
    !inApp &&
    !import.meta.env.DEV &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

function wanted(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on'
  } catch {
    return false
  }
}

function setWanted(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'on')
    else localStorage.removeItem(KEY)
  } catch {}
}

export function pushState(): PushState {
  if (inApp) return 'unsupported'
  // iOS 只有添加到主屏幕后的网页才有 PushManager（16.4 起）
  if (!supported()) return isApple() && !isStandalone() ? 'install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return wanted() && Notification.permission === 'granted' ? 'on' : 'off'
}

/** 云端接口：网页版和云端同源（Caddy 同一个域名） */
async function api(method: 'GET' | 'PUT' | 'DELETE', path: string, token?: string, body?: unknown): Promise<Response> {
  return fetch(location.origin + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean =>
  !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i])

/** 装好的 service worker（public/sw.js）。没注册上时 ready 永远不会完成，所以先查、再限时等 */
async function worker(): Promise<ServiceWorkerRegistration> {
  const broken = () => new Error('提醒组件没装好，刷新页面后再试')
  if (!(await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL))) throw broken()
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(broken()), 10_000)),
  ])
}

/** 取到（或新建）这个浏览器的推送订阅；云端换了公钥时重新订阅 */
async function subscription(): Promise<PushSubscription> {
  const res = await api('GET', '/v1/bridge/push/key')
  if (res.status === 404) throw new Error('云端还没有开通推送')
  if (!res.ok) throw new Error('连不上云端，稍后再试')
  const key = fromBase64Url(((await res.json()) as { key: string }).key)
  const reg = await worker()
  const prior = await reg.pushManager.getSubscription()
  if (prior && sameKey(prior.options.applicationServerKey, key)) return prior
  await prior?.unsubscribe()
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource })
}

/** 在每台配对好的电脑上登记；一台都没登记上时报错，返回没登记上的电脑名 */
async function register(sub: PushSubscription, pairings: readonly Pairing[]): Promise<string[]> {
  const json = sub.toJSON()
  const body = { endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } }
  const targets = pairings.filter(p => p.status === 'paired')
  const ok = await Promise.all(
    targets.map(p =>
      api('PUT', '/v1/bridge/push', p.token, body).then(
        r => r.ok,
        () => false,
      ),
    ),
  )
  const failed = targets.filter((_, i) => !ok[i]).map(p => p.desktopName)
  if (targets.length && failed.length === targets.length) throw new Error('云端没登记上，稍后再试')
  return failed
}

/** 打开锁屏提醒：要在用户点按钮时调用（iOS 只在用户操作里弹授权框）。failed：没登记上的电脑 */
export async function enablePush(pairings: readonly Pairing[]): Promise<{ state: PushState; failed: string[] }> {
  if (!supported()) return { state: pushState(), failed: [] }
  if ((await Notification.requestPermission()) !== 'granted') return { state: pushState(), failed: [] }
  const failed = await register(await subscription(), pairings)
  setWanted(true)
  return { state: pushState(), failed }
}

export async function disablePush(pairings: readonly Pairing[]): Promise<PushState> {
  setWanted(false)
  await Promise.all(pairings.map(p => dropToken(p.token)))
  if (supported()) await (await (await worker()).pushManager.getSubscription())?.unsubscribe()
  return pushState()
}

/** 打开着提醒时：启动、配对了新电脑时再登记一遍（云端按设备存，重复登记没关系） */
export async function syncPush(pairings: readonly Pairing[]): Promise<void> {
  if (pushState() !== 'on') return
  try {
    const failed = await register(await subscription(), pairings)
    if (failed.length) console.warn('锁屏提醒没登记上：', failed.join('、'))
  } catch (e) {
    console.warn('锁屏提醒没登记上', e)
  }
}

/** 忘掉电脑时没取消成的设备令牌（离线时），联网后补 */
const DROPS = 'pixelsky.mobile.push.drop'

function pendingDrops(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(DROPS) ?? '[]')
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

function saveDrops(list: string[]): void {
  try {
    if (list.length) localStorage.setItem(DROPS, JSON.stringify(list))
    else localStorage.removeItem(DROPS)
  } catch {}
}

/** 取消这个设备的订阅；设备在云端已经没了（401 / 404）也算取消了 */
async function dropToken(token: string): Promise<boolean> {
  try {
    const r = await api('DELETE', '/v1/bridge/push', token)
    return r.ok || r.status === 401 || r.status === 404
  } catch {
    return false
  }
}

/** 在手机上忘掉一台电脑：那台电脑别再推过来。没取消成就记下，联网后补 */
export function dropPush(p: Pairing): void {
  if (inApp) return
  void dropToken(p.token).then(ok => {
    if (!ok) saveDrops([...new Set([...pendingDrops(), p.token])])
  })
}

export async function retryDrops(): Promise<void> {
  if (inApp) return
  const left: string[] = []
  for (const token of pendingDrops()) if (!(await dropToken(token))) left.push(token)
  saveDrops(left)
}
