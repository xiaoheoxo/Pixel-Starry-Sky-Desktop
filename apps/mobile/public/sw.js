// 网页版的 service worker（docs/mobile-remote.md §20）：只做一件事——打开页面时没有网络，显示「没有网络」页，而不是浏览器自带的错误页。
// 故意不缓存 JS / CSS / 接口，也不碰 /v1/bridge 和 WebSocket：每次发版后页面都直接取最新的，不会读到旧版本。
const CACHE = 'pixelsky-offline-v1'
const OFFLINE = './offline.html' // 相对 sw.js，线上就是 /m/offline.html

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.add(OFFLINE)))
  // 这个 worker 没有任何要保留的状态，新版装好直接接手，不用等旧页面都关掉
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // 改了离线页就把 CACHE 加一个版本号，旧的在这里清掉
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key)
      // 第一次装好后，已经打开的页面也归它管（否则要刷新一次才生效）
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', event => {
  // 只管「打开页面」：先走网络，网络不通（fetch 抛错）才回退到离线页。服务器返回的 4xx / 5xx 原样给浏览器
  if (event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(async () => (await caches.match(OFFLINE)) ?? Response.error()))
})

// 锁屏提醒（docs/mobile-remote.md §22.2、§23）：电脑经云端推来 { kind, count, session?, badge?, device }，不带任务标题。
// 每条推送都显示通知（iOS 要求，不显示的话会被取消订阅）；电脑那边只推给不在线或页面在后台的手机。
// 点通知：只涉及一个会话时直接打开它，否则回概览；badge 是主屏幕图标上的数字（等你处理的个数）。
const TEXT = {
  waiting: n => `有 ${n} 个任务等你处理`,
  failed: n => `${n} 个任务出错了`,
  completed: n => `${n} 个任务完成`,
}
const ID = /^[A-Za-z0-9_.:~-]{1,128}$/

self.addEventListener('push', event => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {}
  const text = TEXT[data.kind]
  const count = Number.isInteger(data.count) && data.count > 0 ? data.count : 1
  const target = {
    device: typeof data.device === 'string' && ID.test(data.device) ? data.device : null,
    session: typeof data.session === 'string' && ID.test(data.session) ? data.session : null,
  }
  const jobs = [
    self.registration.showNotification('像素星空', {
      body: text ? text(count) : '电脑上的任务有新情况',
      // 同一种只留最新一条
      tag: 'pixelsky-' + (text ? data.kind : 'other'),
      renotify: true,
      icon: './icons/icon-192.png',
      data: target,
    }),
  ]
  const nav = self.navigator
  if (Number.isInteger(data.badge) && nav && 'setAppBadge' in nav)
    jobs.push((data.badge > 0 ? nav.setAppBadge(Math.min(data.badge, 99)) : nav.clearAppBadge()).catch(() => {}))
  event.waitUntil(Promise.all(jobs))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const { device, session } = event.notification.data || {}
  event.waitUntil(
    (async () => {
      const scope = self.registration.scope
      const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).find(c =>
        c.url.startsWith(scope),
      )
      if (open) {
        // 页面开着：先拉到前台，再告诉它打开哪个（platform/notifyOpen.ts）
        let shown = null
        try {
          shown = await open.focus()
        } catch {
          // 有的浏览器不许在这时拉到前台：照样告诉页面
        }
        if (device) (shown || open).postMessage({ type: 'pixelsky-open', device, session })
        return
      }
      const hash = device ? `#open=${encodeURIComponent(session || '')}&device=${encodeURIComponent(device)}` : ''
      return self.clients.openWindow(scope + hash)
    })(),
  )
})
