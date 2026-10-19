// 冒烟测试：用 node（或 Electron 的 ELECTRON_RUN_AS_NODE）跑打好的 pixel.mjs，
// 检查版本、品牌、RPC 模式能起来、自带扩展已打进去。发布流程里 build 之后、electron-builder 之前跑。
//   node scripts/smoke.mjs [--exe <可执行文件>] [--entry <pixel.mjs>]
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const exe = resolve(opt('--exe') ?? process.execPath)
const entry = resolve(opt('--entry') ?? join(root, 'dist', 'pixel-cli', 'pixel.mjs'))
let version
try {
  const pkg = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8'))
  version = pkg.version
  if (pkg.piConfig?.name !== 'pixelsky') throw new Error('package.json 缺 piConfig 或品牌不是 pixelsky')
} catch (e) {
  console.error('冒烟失败：读不到产物旁边的 package.json（品牌靠它）：' + e.message)
  process.exit(1)
}

const agentDir = mkdtempSync(join(tmpdir(), 'pixelsky-smoke-'))
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PIXELSKY_CODING_AGENT_DIR: agentDir }
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PI_PACKAGE_DIR']) delete env[k]

let stderrAll = ''
function fail(msg) {
  console.error('冒烟失败：' + msg)
  if (stderrAll.trim()) console.error('--- stderr ---\n' + stderrAll)
  rmSync(agentDir, { recursive: true, force: true })
  process.exit(1)
}

function run(extra) {
  const r = spawnSync(exe, [entry, ...extra], { env, encoding: 'utf8', timeout: 30000 })
  stderrAll += r.stderr ?? ''
  if (r.status !== 0) fail(`${extra.join(' ')} 退出码 ${r.status}${r.error ? '（' + r.error.message + '）' : ''}`)
  return r.stdout
}

// 1. 版本
const ver = run(['--version']).match(/[0-9]+[.][0-9]+[.][0-9]+/)?.[0]
if (!ver) fail('--version 没有版本号')
if (ver !== version) fail(`--version 是 ${ver}，产物 package.json 是 ${version}`)
console.log('ok --version', ver)

// 2. 品牌：APP_NAME 来自 package.json 的 piConfig，帮助里会出现 PIXELSKY_CODING_AGENT_DIR
if (!run(['--help']).includes('PIXELSKY_CODING_AGENT_DIR'))
  fail('--help 里没有 PIXELSKY_CODING_AGENT_DIR，品牌没生效（package.json 缺失或补丁没打上）')
console.log('ok --help 品牌')

// 3. RPC：get_state / get_commands / get_available_models
const requests = [
  { id: 's', type: 'get_state' },
  { id: 'c', type: 'get_commands' },
  { id: 'm', type: 'get_available_models' },
]
const responses = await new Promise(resolveP => {
  const child = spawn(exe, [entry, '--mode', 'rpc', '--no-session'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  const got = {}
  let buf = ''
  let done = false
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    child.stdin.end()
    child.kill()
    resolveP(got)
  }
  const timer = setTimeout(finish, 30000)
  child.stderr.on('data', d => (stderrAll += d))
  child.on('error', e => {
    stderrAll += String(e)
    finish()
  })
  child.stdout.on('data', d => {
    // 协议要求只按换行切（不能用 readline，它会把 U+2028 也当换行）
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'response' && msg.id) got[msg.id] = msg
      } catch {
        // 非 JSON 行忽略
      }
    }
    if (requests.every(r => got[r.id])) finish()
  })
  for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n')
})
for (const r of requests) {
  const res = responses[r.id]
  if (!res) fail(`RPC ${r.type} 超时没有响应`)
  if (res.success !== true) fail(`RPC ${r.type} 失败：${JSON.stringify(res)}`)
}
if (!responses.c.data?.commands?.some(c => c.name === 'pixelsky-mode'))
  fail('get_commands 里没有 pixelsky-mode，自带扩展没打进去')
console.log('ok RPC get_state / get_commands / get_available_models')

// 4. 运行期依赖：在产物目录里用同一个可执行文件加载 photon / quickjs 的 wasm（跟 Pi 的 worker 一样要读磁盘上的文件）
const loadCheck = [
  "const { readFileSync } = await import('node:fs')",
  "const { createRequire } = await import('node:module')",
  "const require = createRequire(process.cwd() + '/pixel.mjs')",
  "const q = await import('quickjs-wasi')",
  "const w = readFileSync(require.resolve('quickjs-wasi/quickjs.wasm'))",
  'await WebAssembly.compile(w)',
  "await import('@silvia-odwyer/photon-node')",
  "const ph = readFileSync(require.resolve('@silvia-odwyer/photon-node/photon_rs_bg.wasm'))",
  'await WebAssembly.compile(ph)',
  "console.log('wasm-ok', typeof q)",
].join(';')
const lc = spawnSync(exe, ['--input-type=module', '-e', loadCheck], {
  env,
  cwd: dirname(entry),
  encoding: 'utf8',
  timeout: 30000,
})
stderrAll += lc.stderr ?? ''
if (lc.status !== 0 || !lc.stdout.includes('wasm-ok')) fail('quickjs / photon 的 wasm 在产物目录里加载失败')
console.log('ok quickjs / photon wasm 可加载')

rmSync(agentDir, { recursive: true, force: true })
console.log('冒烟通过')
