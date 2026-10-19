// 官方语言扩展按上传标准检查（extensions/official/AUTHORING.md §5）：先构建一次扩展命令行，再逐个 validate（含语法正则和测速）。
// 用法：node scripts/check-extpacks.mjs [名字…]；node scripts/check.mjs --extpacks 时也会跑。任何一个不通过就退出码 1。
// 运行时的验收（按软件加载器加载、任务用例）在 apps/desktop/src/main/extension-packs/official.test.ts，随 test:desktop 跑。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const official = join(root, 'extensions', 'official')
const cli = join(root, 'packages', 'extension-cli')

const wanted = process.argv.slice(2)
const packs = readdirSync(official, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(official, d.name, 'pixelsky-extension.json')))
  .map(d => d.name)
  .filter(name => !wanted.length || wanted.includes(name))
if (!packs.length) {
  console.error('extensions/official 下没有扩展')
  process.exit(1)
}

const build = spawnSync(process.execPath, [join(cli, 'scripts', 'build.mjs')], { encoding: 'utf8' })
if (build.status !== 0) {
  console.error(build.stdout + build.stderr)
  process.exit(1)
}

let failed = 0
for (const name of packs) {
  const run = spawnSync(
    process.execPath,
    [join(cli, 'dist', 'pixelsky-ext.mjs'), 'validate', join(official, name), '--json'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  let report
  try {
    report = JSON.parse(run.stdout)
  } catch {
    console.error(`✗ ${name}：读不懂检查结果\n${run.stdout}${run.stderr}`)
    failed++
    continue
  }
  if (report.verdict?.pass) {
    console.log(`✓ ${name}`)
    continue
  }
  failed++
  console.error(`✗ ${name}：${report.verdict?.blocking ?? '?'} 个问题会被上传拒绝`)
  for (const issue of report.issues ?? []) {
    if (issue.severity === 'error' || issue.upload === 'reject')
      console.error(`  ${issue.severity} ${issue.code} ${issue.path ?? ''} ${issue.message?.zh ?? ''}`)
  }
}
console.log(failed ? `失败 ${failed} 个` : `全部通过（${packs.length} 个）`)
process.exit(failed ? 1 : 0)
