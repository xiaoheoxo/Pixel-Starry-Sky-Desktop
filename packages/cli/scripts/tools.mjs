// 取随包的 rg / fd：从上游 GitHub Release 下载固定版本，按 tools.lock.json 校验 sha256，解到 vendor/<平台>-<架构>/。
// 打包时 apps/desktop/build/after-pack.cjs 按目标架构把对应目录拷进 resources/pixel-cli/bin/（mac 一次出 x64 + arm64，
// 所以不能放进共用的 dist/pixel-cli）。命令行启动时把这个目录接到 PATH 后面，Pi 的 grep / find 和 bash 里都能用。
//
// 用法：
//   node scripts/tools.mjs                     本机平台
//   node scripts/tools.mjs --release           本平台发版要的全部架构（mac 是 x64 + arm64）
//   node scripts/tools.mjs --targets linux-x64,linux-arm64
//   node scripts/tools.mjs --update-lock       锁文件里没有的压缩包，下载后把 sha256 记进去（只在升级版本时用，记完人工核对）
//   PIXELSKY_TOOLS_MIRROR=https://镜像          代替 https://github.com（路径不变）
// 已经解好的目录直接跳过（--force 重新下）。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = join(root, 'tools.lock.json')

/** 版本和资源名与 Pi 自己下载时一致（tools-manager.js 的 getAssetName） */
export const TOOLS = {
  rg: {
    repo: 'BurntSushi/ripgrep',
    // 15.2.0 起才有 aarch64 的 musl 版；15.1.0 及以前 Linux arm64 只有 gnu 版，远程 arm64 机器那份下不到
    version: '15.2.0',
    asset: (v, triple, ext) => `ripgrep-${v}-${triple}.${ext}`,
    tag: v => v,
    licenses: ['LICENSE-MIT', 'UNLICENSE', 'COPYING'],
  },
  fd: {
    repo: 'sharkdp/fd',
    version: '10.3.0',
    asset: (v, triple, ext) => `fd-v${v}-${triple}.${ext}`,
    tag: v => `v${v}`,
    licenses: ['LICENSE-MIT', 'LICENSE-APACHE'],
  },
}

/** 平台-架构 → Rust 目标三元组和压缩格式（linux 用 musl 静态版，任何发行版都能跑） */
export function triple(target) {
  const [platform, arch] = target.split('-')
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  if (!cpu) throw new Error(`不支持的架构：${target}`)
  if (platform === 'win32') return { triple: `${cpu}-pc-windows-msvc`, ext: 'zip', exe: '.exe' }
  if (platform === 'darwin') return { triple: `${cpu}-apple-darwin`, ext: 'tar.gz', exe: '' }
  if (platform === 'linux') return { triple: `${cpu}-unknown-linux-musl`, ext: 'tar.gz', exe: '' }
  throw new Error(`不支持的平台：${target}`)
}

/**
 * 发版时每个 runner 要下载的目标：本机安装包用的（和 electron-builder.yml 的 target 对应）
 * + linux-x64 / linux-arm64（SSH / WSL 远程机器永远是 Linux，每个平台的安装包都要带，见 after-pack.cjs）
 */
export function releaseTargets(platform = process.platform) {
  const own = platform === 'win32' ? ['win32-x64'] : platform === 'darwin' ? ['darwin-x64', 'darwin-arm64'] : []
  return [...new Set([...own, 'linux-x64', 'linux-arm64'])]
}

export function vendorDir(target) {
  return join(root, 'vendor', target)
}

function readLock() {
  return existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : {}
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
}

function extract(archive, dir) {
  // Windows 自带的 bsdtar 认 zip；Git Bash 里的 tar 是 GNU tar，不认，所以写绝对路径
  const tar =
    process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tar, ['-xf', archive, '-C', dir], { stdio: 'pipe' })
}

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (e.name === name) return p
  }
  return null
}

async function fetchTool(name, target, { lock, updateLock }) {
  const tool = TOOLS[name]
  const t = triple(target)
  const asset = tool.asset(tool.version, t.triple, t.ext)
  // PIXELSKY_TOOLS_MIRROR：换掉 https://github.com（镜像、或本机测试用），sha256 照样按锁文件校验
  const base = (process.env.PIXELSKY_TOOLS_MIRROR?.trim() || 'https://github.com').replace(/\/+$/, '')
  const url = `${base}/${tool.repo}/releases/download/${tool.tag(tool.version)}/${asset}`
  const work = mkdtempSync(join(tmpdir(), 'pixelsky-tools-'))
  try {
    const archive = join(work, asset)
    await download(url, archive)
    const hash = sha256(archive)
    if (!lock[asset]) {
      if (!updateLock)
        throw new Error(`tools.lock.json 里没有 ${asset} 的 sha256（升级版本时用 --update-lock 记录并人工核对）`)
      lock[asset] = hash
      console.log(`记录 ${asset} ${hash}`)
    } else if (lock[asset] !== hash) {
      throw new Error(`${asset} 的 sha256 不对：应为 ${lock[asset]}，实际 ${hash}`)
    }
    const unpacked = join(work, 'x')
    mkdirSync(unpacked)
    extract(archive, unpacked)
    const bin = findFile(unpacked, name + t.exe)
    if (!bin) throw new Error(`${asset} 里没找到 ${name}${t.exe}`)
    const out = vendorDir(target)
    mkdirSync(join(out, 'licenses'), { recursive: true })
    copyFileSync(bin, join(out, name + t.exe))
    if (!t.exe) chmodSync(join(out, name), 0o755)
    for (const lic of tool.licenses) {
      const f = findFile(unpacked, lic)
      if (f) copyFileSync(f, join(out, 'licenses', `${name}-${lic}.txt`))
    }
    if (!readdirSync(join(out, 'licenses')).some(f => f.startsWith(name + '-')))
      throw new Error(`${asset} 里没找到许可文本`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** 某个目标的 vendor 目录里 rg / fd 都在 */
export function hasTools(target) {
  const { exe } = triple(target)
  return Object.keys(TOOLS).every(n => existsSync(join(vendorDir(target), n + exe)))
}

async function main(argv) {
  const has = flag => argv.includes(flag)
  const value = flag => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const targets =
    value('--targets')?.split(',').filter(Boolean) ??
    (has('--release') ? releaseTargets() : [`${process.platform}-${process.arch}`])
  const lock = readLock()
  for (const target of targets) {
    if (hasTools(target) && !has('--force')) {
      console.log(`已有 ${target}：${vendorDir(target)}`)
      continue
    }
    for (const name of Object.keys(TOOLS)) await fetchTool(name, target, { lock, updateLock: has('--update-lock') })
    const sizes = readdirSync(vendorDir(target))
      .filter(f => statSync(join(vendorDir(target), f)).isFile())
      .map(f => `${f} ${(statSync(join(vendorDir(target), f)).size / 1024 / 1024).toFixed(1)} MB`)
    console.log(`已取 ${target}：${sizes.join('，')}`)
  }
  if (has('--update-lock')) writeFileSync(lockPath, JSON.stringify(sortKeys(lock), null, 2) + '\n')
}

function sortKeys(o) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exit(1)
  })
}
