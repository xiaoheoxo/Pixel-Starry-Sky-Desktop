// 脚本扩展宿主里跑的代码（docs/ui/extension-commands-plan.md §2）。全部是字符串：经 ext-host 分区的协议发给页面，
// 不进界面的打包，主界面也拿不到
export const EXT_HOST_SCHEME = 'pixelsky-ext-host'

export const HOST_CSP = `default-src 'none'; script-src 'self'; frame-src ${EXT_HOST_SCHEME}:`
export const FRAME_CSP = "default-src 'none'; script-src 'self'; worker-src 'self'"
export const WORKER_CSP = "default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'none'"

export const HOST_HTML = '<!doctype html><meta charset="utf-8"><script src="host.js"></script>'
export const FRAME_HTML = '<!doctype html><meta charset="utf-8"><script src="frame.js"></script>'

/** 启动页：preload 转来「开 / 关」，每个扩展一个 iframe（来源各不相同）；移除 iframe 就结束它的 Worker */
export const HOST_JS = `const frames = new Map()
window.addEventListener('message', e => {
  if (e.source !== window || !e.data) return
  const { type, runId, host } = e.data
  if (type === 'start') {
    const port = e.ports[0], f = document.createElement('iframe')
    f.src = '${EXT_HOST_SCHEME}://' + host + '/frame.html'
    f.onload = () => f.contentWindow.postMessage('port', '${EXT_HOST_SCHEME}://' + host, [port])
    frames.set(runId, f)
    document.documentElement.appendChild(f)
  }
  if (type === 'stop') {
    frames.get(runId)?.remove()
    frames.delete(runId)
  }
})
`

export const FRAME_JS = `window.addEventListener('message', e => {
  if (e.source !== parent || !e.ports[0]) return
  new Worker('/worker.js').postMessage({ port: e.ports[0] }, [e.ports[0]])
})
`

/** 脚本能用的全局：语言内置对象和文字编解码。别的（网络、Blob、IndexedDB、OffscreenCanvas、navigator、定时器…）都删 */
export const WORKER_GLOBALS =
  'Object Function Array Number Boolean String Symbol BigInt Date Promise RegExp Map Set WeakMap WeakSet Proxy Reflect JSON Math Intl Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError ArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array parseFloat parseInt isFinite isNaN encodeURI encodeURIComponent decodeURI decodeURIComponent NaN Infinity undefined TextEncoder TextDecoder'

/** 删不掉也没关系的：DedicatedWorkerGlobalScope 上不可配置的两个数字常量。出现别的就拒绝运行 */
export const WORKER_ALLOWED_SURVIVORS = 'TEMPORARY PERSISTENT'

/**
 * Worker 的启动脚本。用户脚本必须是另一个脚本（importScripts）：同一个脚本里，用户顶层的 function / var 会在这段运行前提升，能覆盖 Set、Reflect 这些内置对象，在全局删掉之前跑起来。
 * 这里抛错就停在这一条，后面的用户脚本不会运行（删不干净就不运行）。
 * 端口留在闭包里；这段不是安全边界，主进程对端口来的每条消息都按不可信校验（api.ts）。
 */
export const WORKER_BOOT = `(function () {
  const G = globalThis
  const on = G.addEventListener.bind(G)
  const load = G.importScripts.bind(G)
  const own = Reflect.ownKeys, del = Reflect.deleteProperty, proto = Reflect.getPrototypeOf, define = Reflect.defineProperty
  const stop = Object.prototype, freeze = Object.freeze, P = Promise, E = Error, Str = String
  const allow = new Set(${JSON.stringify(WORKER_GLOBALS)}.split(' '))
  const survivorsOk = new Set(${JSON.stringify(WORKER_ALLOWED_SURVIVORS)}.split(' '))
  const handlers = new Map(), pending = new Map()
  let port = null, seq = 0, loaded = false, failed = false, started = false, failure = 'load failed'

  const send = m => { if (port) port.postMessage(m) }
  const report = e => {
    failed = true
    failure = Str((e && e.message) || e).slice(0, 500)
    // 加载时端口还没来：maybeReady 再发
    send({ t: 'fail', message: failure })
  }
  const call = (method, args) =>
    new P((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      send({ t: 'call', seq: id, method, args })
    })
  const maybeReady = () => {
    if (!port || started || (!loaded && !failed)) return
    started = true
    send(failed ? { t: 'fail', message: failure } : { t: 'ready' })
  }
  const run = async id => {
    const handler = handlers.get(id)
    try {
      if (!handler) throw new E('command not registered: ' + id)
      await handler()
      send({ t: 'done', ok: true })
    } catch (e) {
      send({ t: 'done', ok: false, message: Str((e && e.message) || e).slice(0, 500) })
    }
  }

  on('error', e => report(e.error || e.message))
  on('unhandledrejection', e => report(e.reason))
  on('message', function init(e) {
    if (port || !e.data || !e.data.port) return
    port = e.data.port
    port.onmessage = m => {
      const d = m.data
      if (d.t === 'run') run(d.id)
      if (d.t === 'reply') {
        const p = pending.get(d.seq)
        if (!p) return
        pending.delete(d.seq)
        if (d.ok) p.resolve(d.value)
        else p.reject(new E(d.message))
      }
    }
    maybeReady()
  })

  // ---- 删全局：先收集整条原型链，再删（边走边删，constructor 没了也不影响） ----
  const chain = []
  for (let o = G; o && o !== stop; o = proto(o)) chain.push(o)
  const left = []
  chain.forEach((o, depth) => {
    for (const name of own(o)) {
      if (depth === 0 && typeof name === 'string' && allow.has(name)) continue
      if (name === Symbol.toStringTag) continue
      if (!del(o, name)) left.push(Str(name))
    }
  })
  const bad = left.filter(n => !survivorsOk.has(n))
  if (bad.length) {
    failed = true
    throw new E('sandbox setup failed: ' + bad.join(','))
  }

  const fn = f => freeze(f)
  const noop = fn(() => undefined)
  const api = {
    commands: freeze({
      register: fn((id, handler) => {
        if (typeof id !== 'string' || typeof handler !== 'function') throw new TypeError('register(id, handler)')
        handlers.set(id, handler)
      }),
    }),
    editor: freeze({
      getContext: fn(() => call('editor.getContext', [])),
      getText: fn(() => call('editor.getText', [])),
      replaceRange: fn((from, to, text) => call('editor.replaceRange', [from, to, text])),
    }),
    ui: freeze({
      showMessage: fn(text => call('ui.showMessage', [text])),
      pick: fn((items, options) => call('ui.pick', [items, options])),
      input: fn(options => call('ui.input', [options])),
    }),
    storage: freeze({
      get: fn(key => call('storage.get', [key])),
      set: fn((key, value) => call('storage.set', [key, value])),
      delete: fn(key => call('storage.delete', [key])),
    }),
  }
  const constant = value => ({ value, writable: false, enumerable: false, configurable: false })
  define(G, 'pixelsky', constant(freeze(api)))
  // shortcut: console 是空实现，作者看不到日志；要调试体验时再转发给开发中的文件夹扩展
  define(G, 'console', constant(freeze({ log: noop, info: noop, warn: noop, error: noop, debug: noop })))

  try {
    load('/user.js')
    loaded = true
  } catch (e) {
    report(e)
  }
  maybeReady()
})();`

export const WORKER_JS = `'use strict';\n${WORKER_BOOT}\n`

/** 严格模式不跨脚本，用户脚本自己要写一次 */
export const userScript = (code: string): string => `'use strict';\n${code}\n`
