// 本机打手机 App（apps/app）的安卓正式签名包（docs/mobile-app.md §8.6）：
// flutter build apk --release → apps/app/build/dist/pixelsky-<版本>.apk，打印 SHA-256 和签名证书指纹；
// 同目录写 latest.json（App 内检查更新和官网读它，§16.1），更新说明取 .github/release-notes/app-v<版本>.md。
// 上传到官网下载目录用 scripts/publish-app.mjs。
// 签名密钥在仓库外（默认 ~/.pixelsky/app-release.properties，或环境变量 PIXELSKY_KEY_PROPERTIES），找不到就不打包。
// 需要 flutter 在 PATH 上；打印证书指纹要 ANDROID_HOME（没有就跳过这一项）。iOS 包只能在工作流（.github/workflows/app.yml）里打。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const app = join(root, 'apps', 'app')

const keyFile = process.env.PIXELSKY_KEY_PROPERTIES ?? join(homedir(), '.pixelsky', 'app-release.properties')
if (!existsSync(keyFile)) {
  console.error(
    `找不到正式签名：${keyFile}\n（不带签名的包装不到正式版上面覆盖，所以不打包。生成方法见 docs/release-update.md「手机 App」）`,
  )
  process.exit(1)
}

// Windows 上 flutter、apksigner 是 .bat，要经 cmd /c（同 check.mjs）
const run = (tool, args, cwd, capture = false) =>
  new Promise((done, fail) => {
    const [command, argv] = process.platform === 'win32' ? ['cmd', ['/c', tool, ...args]] : [tool, args]
    const child = spawn(command, argv, { cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' })
    let out = ''
    child.stdout?.on('data', chunk => (out += chunk))
    child.on('error', fail)
    child.on('close', code => (code === 0 ? done(out) : fail(new Error(`${tool} 退出码 ${code}`))))
  })

const version = /^version:\s*(\S+)/m.exec(readFileSync(join(app, 'pubspec.yaml'), 'utf8'))?.[1]
if (!version) throw new Error('pubspec.yaml 里没有 version')
const name = version.split('+')[0]

await run('flutter', ['build', 'apk', '--release'], app)

const built = join(app, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk')
const dist = join(app, 'build', 'dist')
mkdirSync(dist, { recursive: true })
const target = join(dist, `pixelsky-${name}.apk`)
copyFileSync(built, target)

const sha = createHash('sha256').update(readFileSync(target)).digest('hex')
console.log(`\n安装包：${target}\n版本：${version}\nSHA-256：${sha}`)

// latest.json：字段和 App 的 AppRelease.parse（apps/app/lib/data/app_update.dart）对应，文件名只能是同目录下的
const build = Number(version.split('+')[1])
if (!Number.isInteger(build) || build <= 0) throw new Error(`pubspec.yaml 的 version 要带 +版本号数字：${version}`)
const notesFile = join(root, '.github', 'release-notes', `app-v${name}.md`)
const notes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8').trim() : ''
if (!notes) console.warn(`没有更新说明（${notesFile}），latest.json 里 notes 为空`)
const manifest = {
  version: name,
  build,
  file: `pixelsky-${name}.apk`,
  size: statSync(target).size,
  sha256: sha,
  notes,
  date: new Date().toISOString().slice(0, 10),
}
writeFileSync(join(dist, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`更新清单：${join(dist, 'latest.json')}`)

// 签名证书指纹：每次都应该是同一个，变了就是用错了密钥（装不上覆盖）
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
const tools = sdk && join(sdk, 'build-tools')
if (tools && existsSync(tools)) {
  const latest = readdirSync(tools)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .at(-1)
  const apksigner = join(tools, latest, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')
  const certs = await run(apksigner, ['verify', '--print-certs', target], root, true)
  const digest = /certificate SHA-256 digest:\s*(\S+)/.exec(certs)?.[1]
  console.log(`签名证书 SHA-256：${digest ?? '（没读到）'}`)
} else {
  console.log('没有 ANDROID_HOME，跳过签名证书检查')
}
