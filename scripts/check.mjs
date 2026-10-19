// 统一检查入口（无依赖，不经过 pnpm）
// 用法：node scripts/check.mjs [--fast] [--strict] [--remote] [--build] [--cloud] [--extpacks] [--only <步骤名>]
// --cloud 加跑 services/cloud 的 Go 检查（gofmt、go vet、go test），需要本机装 Go 1.27 或更新版本
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = flag => args.includes(flag)
const onlyIndex = args.indexOf('--only')
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined
const strict = has('--strict')

const desktop = join(root, 'apps', 'desktop')
const engine = join(root, 'packages', 'engine')
const protocol = join(root, 'packages', 'protocol')
const extcli = join(root, 'packages', 'extension-cli')
const cli = join(root, 'packages', 'cli')
const link = join(root, 'packages', 'link')
const mobile = join(root, 'apps', 'mobile')
const tsc = (cwd, project) => ({
  cwd,
  script: join(cwd, 'node_modules', 'typescript', 'bin', 'tsc'),
  args: ['--noEmit', '-p', project],
})
const vitest = (cwd, extra = []) => ({
  cwd,
  script: join(cwd, 'node_modules', 'vitest', 'vitest.mjs'),
  // GitHub 的机器比本机慢很多，单个测试默认 5 秒不够（真起进程、查注册表的测试）
  args: ['run', ...extra, ...(process.env.CI ? ['--testTimeout=20000', '--hookTimeout=30000'] : [])],
})

const buildDir = join(root, 'scratch', `${new Date().toISOString().slice(0, 10)}-check-build-${process.pid}`)

// 云端服务（Go）：独立的 go.mod，不经过 node；只有 --cloud 时才跑
const cloud = join(root, 'services', 'cloud')
const goCommand = (name, args) => ({ name, group: 'cloud', cwd: cloud, command: 'go', args })

// group：fast 只跑 tsc 和 docs
const steps = [
  { name: 'tsc:desktop-web', group: 'tsc', ...tsc(desktop, 'tsconfig.web.json') },
  { name: 'tsc:desktop-node', group: 'tsc', ...tsc(desktop, 'tsconfig.node.json') },
  { name: 'tsc:engine', group: 'tsc', ...tsc(engine, 'tsconfig.json') },
  { name: 'tsc:protocol', group: 'tsc', ...tsc(protocol, 'tsconfig.json') },
  { name: 'tsc:extension-cli', group: 'tsc', ...tsc(extcli, 'tsconfig.json') },
  // 像素星空命令行（packages/cli）没有自己的 typescript 依赖，用根目录的
  {
    name: 'tsc:cli',
    group: 'tsc',
    cwd: cli,
    script: join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    args: ['--noEmit', '-p', 'tsconfig.json'],
  },
  { name: 'tsc:link', group: 'tsc', ...tsc(link, 'tsconfig.json') },
  { name: 'tsc:mobile', group: 'tsc', ...tsc(mobile, 'tsconfig.json') },
  {
    name: 'test:desktop',
    group: 'test',
    ...vitest(desktop, ['src/renderer/src', 'src/main', 'src/shared', 'src/workers', '--root', '.']),
  },
  { name: 'test:engine', group: 'test', ...vitest(engine) },
  { name: 'test:protocol', group: 'test', ...vitest(protocol) },
  { name: 'test:extension-cli', group: 'test', ...vitest(extcli) },
  { name: 'test:cli', group: 'test', ...vitest(cli) },
  { name: 'test:link', group: 'test', ...vitest(link) },
  { name: 'test:mobile', group: 'test', ...vitest(mobile) },
  { name: 'docs', group: 'docs', cwd: root, script: join(root, 'scripts', 'check-docs.mjs'), args: [] },
  {
    name: 'eslint',
    group: 'lint',
    optional: true,
    cwd: root,
    script: join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'),
    args: ['.'],
  },
  {
    name: 'prettier',
    group: 'lint',
    optional: true,
    cwd: root,
    script: join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs'),
    args: ['--check', '.'],
  },
  // 官方语言扩展按上传标准检查（含语法测速，机器忙时可能偏慢）；只有 --extpacks 时才跑
  { name: 'extpacks', group: 'extpacks', cwd: root, script: join(root, 'scripts', 'check-extpacks.mjs'), args: [] },
  { name: 'remote', group: 'remote', cwd: root, script: join(root, 'scripts', 'check-remote.mjs'), args: [] },
  {
    name: 'build',
    group: 'build',
    cwd: desktop,
    script: join(desktop, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
    args: ['build', '--outDir', buildDir],
    // 构建出来的主进程包里不能有语法引擎（检查进程另有一个入口）；要在 cleanup 删掉输出之前查
    verify: { script: join(root, 'scripts', 'check-main-bundle.mjs'), args: [buildDir] },
    cleanup: () => rmSync(buildDir, { recursive: true, force: true }),
  },
  // gofmt -l 没有退出码告警，有输出就是没格式化，所以用 failOnOutput
  { name: 'cloud:gofmt', group: 'cloud', cwd: cloud, command: 'gofmt', args: ['-l', '.'], failOnOutput: true },
  goCommand('cloud:vet', ['vet', './...']),
  goCommand('cloud:test', ['test', './...', '-count=1']),
]

const selected = steps.filter(step => {
  if (only) return step.name === only || step.group === only
  if (step.group === 'remote') return has('--remote')
  if (step.group === 'build') return has('--build')
  if (step.group === 'cloud') return has('--cloud')
  if (step.group === 'extpacks') return has('--extpacks')
  // 文档只在本机，仓库里没有 check-docs.mjs 时跳过
  if (step.group === 'docs' && !existsSync(step.script)) return false
  if (has('--fast')) return step.group === 'tsc' || step.group === 'docs'
  return true
})

if (only && selected.length === 0) {
  console.error(`未知步骤：${only}（可用：${[...new Set(steps.flatMap(s => [s.name, s.group]))].join(', ')}）`)
  process.exit(2)
}

// 子进程环境去掉 ELECTRON_RUN_AS_NODE
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const run = step =>
  new Promise(done => {
    // 有 command 的步骤直接调用外部命令（如 go），否则用 node 运行脚本
    const file = step.command ?? process.execPath
    const argv = step.command ? step.args : [step.script, ...step.args]
    const child = spawn(file, argv, {
      cwd: step.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.on('error', error => {
      const hint =
        error.code === 'ENOENT' && step.command
          ? `未找到命令 ${step.command}。--cloud 需要本机安装 Go 1.27 或更新版本，并把 go、gofmt 加入 PATH（https://go.dev/dl/）\n`
          : ''
      done({ code: 1, output: output + hint + String(error) })
    })
    child.on('close', code => done({ code: code ?? 1, output }))
  })

const seconds = start => `${((Date.now() - start) / 1000).toFixed(1)}s`
const failed = []
const skipped = []

for (const step of selected) {
  if (step.optional && !existsSync(step.script)) {
    if (strict) {
      console.log(`✗ ${step.name}  未安装（--strict）`)
      failed.push(step.name)
    } else {
      console.log(`- ${step.name}  跳过（未安装）`)
      skipped.push(step.name)
    }
    continue
  }
  const start = Date.now()
  let result = await run(step)
  if (result.code === 0 && step.verify) {
    const verified = await run({ cwd: root, ...step.verify })
    result = { code: verified.code, output: result.output + verified.output }
  }
  step.cleanup?.()
  const passed = result.code === 0 && !(step.failOnOutput && result.output.trim() !== '')
  if (passed) {
    console.log(`✓ ${step.name}  ${seconds(start)}`)
  } else {
    console.log(`✗ ${step.name}  ${seconds(start)}`)
    // 失败时只展示输出末尾，避免刷屏
    const lines = result.output.trimEnd().split('\n')
    console.log(
      lines
        .slice(-40)
        .map(line => `    ${line}`)
        .join('\n'),
    )
    // GitHub Actions：把失败输出写成错误标注，运行页上直接看得到（不登录也能读到）
    if (process.env.GITHUB_ACTIONS) {
      const text = lines
        .slice(-60)
        .join('\n')
        // 去掉终端颜色码
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A')
      console.log(`::error title=检查失败：${step.name}::${text}`)
    }
    failed.push(step.name)
  }
}

console.log('')
if (skipped.length) {
  console.log(`跳过：${skipped.join('、')}。安装命令：`)
  console.log(
    '  pnpm add -Dw prettier@3.6.2 eslint@9.36.0 @eslint/js@9.36.0 typescript-eslint@8.44.0 eslint-plugin-react-hooks@5.2.0 globals@16.4.0 typescript@5.9.3',
  )
}
if (failed.length) {
  console.log(`失败 ${failed.length} 项：${failed.join('、')}`)
  process.exit(1)
}
console.log('全部通过')
