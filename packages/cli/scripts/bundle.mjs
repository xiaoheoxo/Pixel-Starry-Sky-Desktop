// 把像素星空命令行（连同打过补丁的 Pi 和全部 JS 依赖）打成 dist/pixel-cli/pixel.mjs，随安装包发布。
// 运行时按路径读取的文件（wasm、worker、主题、导出模板）按 Pi 自己的目录结构放在 pixel.mjs 旁边。
// 产物不含原生模块，跟架构无关。说明见 README「打包」一节。
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 不能直接输出到 dist/ 根目录：Pi 从 pixel.mjs 往上找 package.json，目录叫 dist 时会越过去认成 packages/cli/package.json，品牌就退回 pi
const out = join(root, 'dist', 'pixel-cli')

// Pi 的 exports 里没有 ./package.json，所以按目录找
const piDir = realpathSync(join(root, 'node_modules', '@earendil-works', 'pi-coding-agent'))
const pi = JSON.parse(readFileSync(join(piDir, 'package.json'), 'utf8'))
if (pi.piConfig?.name !== 'pixelsky') {
  console.error(
    'Pi 的 package.json 里 piConfig.name 不是 pixelsky：pnpm 补丁没生效（patches/@earendil-works__pi-coding-agent@*.patch），先 pnpm install',
  )
  process.exit(1)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/cli.ts'],
  outfile: join(out, 'pixel.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Pi 的 bundled-node 模式：codemode worker 读旁边的 codemode-worker.js，扩展用内置模块
  define: { PI_BUNDLED_NODE: 'true' },
  // wasm 要按路径读，只能留在 node_modules 里；后两个是可选的动态 import
  external: ['@silvia-odwyer/photon-node', 'quickjs-wasi', 'kerberos', '@aws-sdk/signature-v4-crt'],
  banner: {
    js: [
      "import { createRequire as __pixelRequire } from 'node:module';",
      'const require = __pixelRequire(import.meta.url);',
      // 和 cli.ts 一样，再设一次：不依赖 esbuild 对动态 import 的求值顺序
      "process.env.PI_TELEMETRY ??= '0'; process.env.PI_SKIP_VERSION_CHECK ??= '1';",
    ].join('\n'),
  },
  minifyWhitespace: true,
  minifySyntax: true, // 不压缩标识符，和上游一样，保留调用栈可读
  metafile: true,
  logLevel: 'warning',
})

function mustExist(path, hint) {
  if (!existsSync(path)) {
    console.error(`缺少 ${path}${hint ? '（' + hint + '）' : ''}`)
    process.exit(1)
  }
  return path
}

// 两个 worker：上游 bundle 里的现成文件
const chunks = join(piDir, 'dist', 'bundle', 'chunks')
for (const name of ['codemode-worker.js', 'image-resize-worker.js']) {
  cpSync(mustExist(join(chunks, name), '升级 Pi 后文件名可能变了，检查 bundle.mjs'), join(out, name))
}

// 目录里还混着 tsc 的输出（.d.ts / .map / 同名 .js），bundle 里已经有了；vendor 下的 .js 是导出页面用的数据，要留
const isCompiled = p =>
  /[.]d[.]ts$|[.]map$/.test(p) || (/[.]js$/.test(p) && !p.includes('vendor') && !/template[.]js$/.test(p))

// 主题、图片、导出模板：Pi 从 <pkgDir>/dist/... 读
for (const sub of ['modes/interactive/theme', 'modes/interactive/assets', 'core/export-html']) {
  cpSync(mustExist(join(piDir, 'dist', sub)), join(out, 'dist', sub), {
    recursive: true,
    // dist 里还有 tsc 的 .js / .d.ts / .map，bundle 里已经有了，只要数据文件
    filter: p => !isCompiled(p),
  })
}

// 运行时包：只拷运行时文件，去掉类型声明、sourcemap 和 README
const requireFromPi = createRequire(join(piDir, 'package.json'))
const runtimePkgs = []
for (const name of ['@silvia-odwyer/photon-node', 'quickjs-wasi']) {
  const src = dirname(requireFromPi.resolve(`${name}/package.json`))
  cpSync(src, join(out, 'node_modules', name), {
    recursive: true,
    filter: p => !/(\.d\.ts|\.d\.mts|\.d\.cts|\.map|README(\.md)?)$/i.test(p) && !/[\\/]node_modules$/.test(p),
  })
  runtimePkgs.push(src)
}
for (const f of ['photon_rs_bg.wasm']) mustExist(join(out, 'node_modules/@silvia-odwyer/photon-node', f))
mustExist(join(out, 'node_modules/quickjs-wasi/quickjs.wasm'))

// package.json：Pi 靠它读品牌（piConfig）
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify(
    { name: pi.name, version: pi.version, private: true, type: 'module', piConfig: pi.piConfig },
    null,
    2,
  ) + '\n',
)

// 第三方许可
const piLicense = readFileSync(join(root, 'LICENSES', 'pi-coding-agent-MIT.txt'), 'utf8')
mkdirSync(join(out, 'LICENSES'), { recursive: true })
writeFileSync(join(out, 'LICENSES', 'pi-coding-agent-MIT.txt'), piLicense)

const pkgDirs = new Set(runtimePkgs)
for (const input of Object.keys(result.metafile.inputs)) {
  const p = resolve(root, input).replace(/\\/g, '/')
  const m = [...p.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].pop()
  if (m) pkgDirs.add(p.slice(0, m.index) + 'node_modules/' + m[1])
}
const sections = [`## @earendil-works/pi-coding-agent@${pi.version} (MIT)\n\n${piLicense.trim()}\n`]
const seen = new Set(['@earendil-works/pi-coding-agent'])
for (const dir of [...pkgDirs].sort()) {
  let meta
  try {
    meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  const id = `${meta.name}@${meta.version}`
  if (seen.has(meta.name) || seen.has(id)) continue
  seen.add(id)
  const license =
    typeof meta.license === 'string'
      ? meta.license
      : (meta.license?.type ?? meta.licenses?.map(l => l.type).join(' OR ') ?? '未知')
  const files = readdirSync(dir).filter(f => /^(licen[sc]e|copying|notice)/i.test(f) && statSync(join(dir, f)).isFile())
  const texts = files.map(f => `--- ${f} ---\n${readFileSync(join(dir, f), 'utf8').trim()}`)
  if (files.length === 0 && !meta.name.startsWith('@earendil-works/')) {
    // 包里没带许可文本的，必须在 LICENSES/extra/<包名>.txt 手工补（核对过上游），否则构建失败
    const name = meta.name.replace('/', '__')
    const extra = join(root, 'LICENSES', 'extra', name + '.txt')
    if (!existsSync(extra)) throw new Error(`${id} 没找到许可文本，请补 ${extra}`)
    texts.push(`--- ${name}.txt（手工补充）---\n${readFileSync(extra, 'utf8').trim()}`)
  }
  sections.push(`## ${id} (${license})\n\n${texts.join('\n\n')}\n`)
}
writeFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), `像素星空命令行随包分发的第三方软件\n\n${sections.join('\n')}`)

// 总大小
function size(dir) {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    n += e.isDirectory() ? size(p) : statSync(p).size
  }
  return n
}
console.log(`已生成 ${out}（${(size(out) / 1024 / 1024).toFixed(1)} MB，${pkgDirs.size + 1} 个许可条目）`)
