// Dart ↔ TS 实时互通验证（docs/mobile-app.md §8 A0）：本机起模拟中转（relay.mjs）+ 真网关扮演的电脑（desktop.mjs），
// 每个场景重新生成配对链接，跑一次 Dart 探针（apps/app/tool/link_probe.dart），核对退出码和电脑这边看到的结果。
// 用法：node scripts/app-interop/run.mjs [场景…]      不给场景时全跑
//       node scripts/app-interop/run.mjs --serve       只起中转和电脑，打印配对链接，手动跑探针
// 核对探针的检查有效：INTEROP_TAMPER=off（篡改场景不改帧）或 INTEROP_TAMPER=phone:3 / desktop:2（任何场景都改第 n 个数据帧），
// 这时对应场景应该失败。
// 打包产物和日志放 scratch/<日期>-app-interop-<进程号>/：全部通过就删掉，失败（或出错）时保留并打印路径。
// 需要 dart 在 PATH 上（Windows 上是 dart.bat），或用环境变量 DART 指定。
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { need, root } from './deps.mjs'
import { startRelay } from './relay.mjs'

const app = join(root, 'apps', 'app')
const dart = process.env.DART ?? 'dart'
/** 单个场景最长等多久：探针自己有各步超时，这里只防整个进程挂住 */
const PROBE_LIMIT_MS = 120_000

// 日期 + 进程号，避免和别的检查、别的会话的互通验证冲突（同 check.mjs 的 buildDir）
const outDir = join(root, 'scratch', `${new Date().toISOString().slice(0, 10)}-app-interop-${process.pid}`)
mkdirSync(outDir, { recursive: true })
const logFile = join(outDir, 'run.log')

/** 打印并同时写进日志文件 */
function print(text) {
  console.log(text)
  appendFileSync(logFile, text + '\n')
}

/** desktop.mjs 要导入桌面端的 TS 源码：先用 esbuild 打包（@pixelsky/engine 换成 engine.mjs，只取用到的模块） */
async function loadDesktop() {
  const out = join(outDir, 'desktop.bundle.mjs')
  await need('esbuild').build({
    entryPoints: [join(root, 'scripts', 'app-interop', 'desktop.mjs')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
    // ws 是 CommonJS，打进 ESM 后要有 require 才能取 node 内置模块
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url)" },
    alias: { '@pixelsky/engine': join(root, 'scripts', 'app-interop', 'engine.mjs') },
  })
  return import(pathToFileURL(out).href)
}

const t0 = Date.now()
const stamp = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(6)
const logger = who => text => print(`${stamp()} [${who}] ${text}`)

/** 每个场景：中转要怎么改帧、跑完后电脑这边要核对什么 */
const SCENARIOS = {
  ok: {
    check: (d, before) => (d.received.length === before.received + 1 ? null : '电脑没收到手机发的大消息'),
  },
  'wrong-secret': {
    check: d => {
      const p = d.gateway.pairingState()
      return p?.status === 'waiting' && !p.request ? null : `电脑的配对状态不对：${JSON.stringify(p)}`
    },
  },
  'wrong-key': { check: () => null },
  'tamper-down': { tamper: { to: 'phone', data: 2 }, check: () => null },
  'tamper-up': {
    tamper: { to: 'desktop', data: 2 },
    check: (d, before) => (d.dropped.length === before.dropped + 1 ? null : '电脑没有作废那条加密会话'),
  },
}

/** 环境变量 INTEROP_TAMPER 盖过场景自己的改帧设置 */
function tamperOf(spec) {
  const env = process.env.INTEROP_TAMPER
  if (env === 'off') return null
  const m = /^(phone|desktop):(\d+)$/.exec(env ?? '')
  if (m) return { to: m[1], data: Number(m[2]) }
  return spec.tamper ? { ...spec.tamper } : null
}

function probe(scenario, offer) {
  const log = logger('手机')
  return new Promise(resolve => {
    const args = ['run', 'tool/link_probe.dart', '--scenario', scenario, offer]
    // Windows 上 dart 是 .bat，spawn 不经过 shell 找不到，要经 cmd /c（同 check.mjs 的 appCommand）；
    // 配对链接里只有字母数字和 :/#=-_，cmd 不会改它
    const win = process.platform === 'win32'
    const child = spawn(win ? 'cmd' : dart, win ? ['/c', dart, ...args] : args, { cwd: app, windowsHide: true })
    let buffer = ''
    const onData = chunk => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop()
      for (const line of lines) if (line.trim()) log(line)
    }
    child.stdout.setEncoding('utf8').on('data', onData)
    child.stderr.setEncoding('utf8').on('data', onData)
    // 超时：杀掉整棵进程树（cmd 下面还有 dart）
    const timer = setTimeout(() => {
      log(`探针 ${PROBE_LIMIT_MS / 1000} 秒没有结束，强制结束`)
      if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }, PROBE_LIMIT_MS)
    child.on('error', error => {
      clearTimeout(timer)
      log(`没能启动 ${dart}：${error.message}`)
      resolve(-1)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (buffer.trim()) log(buffer)
      resolve(code)
    })
  })
}

/** 返回退出码：0 全部通过 */
async function main() {
  const relay = await startRelay({ log: logger('中转'), ping: 500 })
  try {
    const { startDesktop } = await loadDesktop()
    const desktop = await startDesktop({ relayUrl: relay.url, relay, log: logger('电脑') })
    try {
      logger('电脑')(`电脑公钥指纹 ${desktop.fingerprint}`)

      if (process.argv.includes('--serve')) {
        const offer = await desktop.newOffer()
        print(`\n配对链接（5 分钟有效，用一次换一个：重启本脚本）：\n${offer}\n`)
        print(`在 apps/app 里跑：dart run tool/link_probe.dart "<上面的链接>"\n按 Ctrl+C 结束`)
        await new Promise(resolve => process.once('SIGINT', resolve))
        return 0
      }

      const wanted = process.argv.slice(2).filter(a => !a.startsWith('--'))
      const names = wanted.length ? wanted : Object.keys(SCENARIOS)
      const results = []
      for (const name of names) {
        const spec = SCENARIOS[name]
        if (!spec) throw new Error('没有这个场景：' + name)
        print(`\n${'='.repeat(20)} 场景 ${name} ${'='.repeat(20)}`)
        const offer = await desktop.newOffer()
        logger('电脑')(`生成配对链接 ${offer.slice(0, 60)}…`)
        relay.state.tamper = tamperOf(spec)
        const before = { received: desktop.received.length, dropped: desktop.dropped.length }
        const code = await probe(name, offer)
        // 等中转把 phone_left 转给电脑、电脑收尾
        await new Promise(r => setTimeout(r, 300))
        const problem = code !== 0 ? `探针退出码 ${code}` : spec.check(desktop, before)
        if (relay.state.tamper) results.push({ name, problem: '中转没有改到帧' })
        else results.push({ name, problem })
        relay.state.tamper = null
      }
      print(`\n${'='.repeat(20)} 结果 ${'='.repeat(20)}`)
      for (const r of results) print(`${r.problem ? '✗' : '✓'} ${r.name}${r.problem ? '：' + r.problem : ''}`)
      return results.some(r => r.problem) ? 1 : 0
    } finally {
      desktop.stop()
    }
  } finally {
    await relay.close()
  }
}

let code = 1
try {
  code = await main()
} catch (error) {
  print(`互通验证出错：${error?.stack ?? error}`)
}
if (code === 0) {
  rmSync(outDir, { recursive: true, force: true, maxRetries: 3 })
} else {
  // 失败时留着日志和打包产物，排查用；用完自己删（node scripts/clean-scratch.mjs）
  console.log(`\n日志和打包产物保留在 ${outDir}`)
}
process.exit(code)
