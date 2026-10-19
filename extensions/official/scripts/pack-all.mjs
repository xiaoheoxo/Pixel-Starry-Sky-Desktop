// 把官方语言扩展逐个打成上传用的 zip，放进 extensions/official/dist/（不入库）。
// 用法（仓库根目录）：node extensions/official/scripts/pack-all.mjs [名字…]；打包前会按上传标准检查，不通过的不打。
// 上架：云端管理页「待审核 › 上传官方扩展…」逐个上传，先测试站、再正式站（AUTHORING.md、docs/ui/official-language-extensions.md §4）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const official = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(official, '..', '..')
const cli = join(root, 'packages', 'extension-cli')
const out = join(official, 'dist')

const wanted = process.argv.slice(2)
const packs = readdirSync(official, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(official, d.name, 'pixelsky-extension.json')))
  .map(d => d.name)
  .filter(name => !wanted.length || wanted.includes(name))

const build = spawnSync(process.execPath, [join(cli, 'scripts', 'build.mjs')], { stdio: 'inherit' })
if (build.status !== 0) process.exit(1)
mkdirSync(out, { recursive: true })

let failed = 0
for (const name of packs) {
  // pack 自己会先按上传标准检查，不通过时不写 zip、退出码 1
  const run = spawnSync(
    process.execPath,
    [join(cli, 'dist', 'pixelsky-ext.mjs'), 'pack', join(official, name), '-o', out],
    {
      stdio: 'inherit',
    },
  )
  if (run.status !== 0) failed++
}
console.log(failed ? `失败 ${failed} 个` : `全部打好，在 ${out}`)
process.exit(failed ? 1 : 0)
