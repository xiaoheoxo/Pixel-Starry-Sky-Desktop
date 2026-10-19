// 打包后（electron-builder 的 afterPack）：
// 1. 所有平台：补拷 node_modules、按目标架构放随包的 rg / fd（resources/pixel-cli/bin），并检查像素星空命令行（resources/pixel-cli）是否完整，
//    缺了就让打包失败，不出一个漏了命令行或搜索工具的安装包；
//    另外把 Linux 版 rg / fd（x64 + arm64）放到 resources/pixel-cli-linux/<架构>，给 SSH / WSL 远程机器装命令行时用（远程机器永远是 Linux）
// 2. macOS：node-pty 的 spawn-helper 必须能执行，不然终端一打开就报 posix_spawnp failed。npm 包里的权限有时会丢，这里统一补上
const { chmodSync, cpSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

// electron-builder 的 extraResources 不管 filter 怎么写都会丢掉 node_modules 目录（实测），所以 wasm 所在的 node_modules 在这里补拷
const PIXEL_CLI_SRC = join(__dirname, '../../../packages/cli/dist/pixel-cli')
// rg / fd 按平台和架构分目录（packages/cli/scripts/tools.mjs 下载）；mac 一次出 x64 + arm64，所以不能放进上面那个共用目录
const PIXEL_TOOLS_SRC = join(__dirname, '../../../packages/cli/vendor')
// electron-builder 的 Arch 枚举
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

const PIXEL_CLI_FILES = [
  'pixel.mjs',
  'package.json',
  'THIRD_PARTY_NOTICES.txt',
  'LICENSES/pi-coding-agent-MIT.txt',
  'codemode-worker.js',
  'image-resize-worker.js',
  'node_modules/quickjs-wasi/quickjs.wasm',
  'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm',
]

exports.default = async function afterPack(context) {
  const isMac = context.electronPlatformName === 'darwin'
  const app = isMac ? readdirSync(context.appOutDir).find(name => name.endsWith('.app')) : undefined
  if (isMac && !app) throw new Error('没找到 .app：' + context.appOutDir)
  const resources = isMac ? join(context.appOutDir, app, 'Contents/Resources') : join(context.appOutDir, 'resources')

  if (existsSync(join(PIXEL_CLI_SRC, 'node_modules'))) {
    cpSync(join(PIXEL_CLI_SRC, 'node_modules'), join(resources, 'pixel-cli', 'node_modules'), { recursive: true })
  }
  const target = context.electronPlatformName + '-' + ARCH[context.arch]
  const exe = context.electronPlatformName === 'win32' ? '.exe' : ''
  const tools = join(PIXEL_TOOLS_SRC, target)
  for (const name of ['rg', 'fd'])
    if (!existsSync(join(tools, name + exe)))
      throw new Error(
        '缺少随包的 ' +
          name +
          '（先 pnpm --filter @pixelsky/cli exec node scripts/tools.mjs --release，见 packages/cli/scripts/tools.mjs）：' +
          join(tools, name + exe),
      )
  cpSync(tools, join(resources, 'pixel-cli', 'bin'), { recursive: true })
  if (!exe) for (const name of ['rg', 'fd']) chmodSync(join(resources, 'pixel-cli', 'bin', name), 0o755)

  // 远程机器用的 Linux 版 rg / fd：不管打哪个平台的包都带；x64 必须有，arm64 有就带（树莓派、ARM 云主机）
  for (const arch of ['x64', 'arm64']) {
    const linux = join(PIXEL_TOOLS_SRC, 'linux-' + arch)
    const ok = ['rg', 'fd'].every(name => existsSync(join(linux, name)))
    if (!ok) {
      if (arch === 'x64')
        throw new Error(
          '缺少给远程机器用的 Linux 版 rg / fd（先 pnpm --filter @pixelsky/cli exec node scripts/tools.mjs --release，见 packages/cli/scripts/tools.mjs）：' +
            linux,
        )
      continue
    }
    const dest = join(resources, 'pixel-cli-linux', arch)
    cpSync(linux, dest, { recursive: true })
    if (!exe) for (const name of ['rg', 'fd']) chmodSync(join(dest, name), 0o755)
  }

  for (const file of PIXEL_CLI_FILES) {
    const path = join(resources, 'pixel-cli', file)
    if (!existsSync(path))
      throw new Error('安装包里缺少像素星空命令行文件（先 pnpm build，见 packages/cli/scripts/bundle.mjs）：' + path)
  }

  if (!isMac) return
  const prebuilds = join(resources, 'app.asar.unpacked/node_modules/node-pty/prebuilds')
  if (!existsSync(prebuilds)) throw new Error('没找到 node-pty 的预编译文件：' + prebuilds)
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
