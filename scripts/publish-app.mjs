// 把 build-app.mjs 打好的安卓包传到官网下载目录（docs/mobile-app.md §16.1）：
//   1. 核对本机 apps/app/build/dist/ 的 APK 和 latest.json 对得上（文件名、大小、sha256）；
//   2. APK 先传成 .part，在服务器上算 sha256 一致才改名；
//   3. 最后换 latest.json（也是先传 .part 再改名），App 和官网读到它时 APK 已经在了；
//   4. 下载目录里只留这一版和上一版的 APK（上一版用来回退：把旧 latest.json 拷回去就行，备份在 latest.prev.json）。
// 用法：PIXELSKY_DOWNLOAD_SSH=<用户@主机> node scripts/publish-app.mjs [--dry-run]
//   目录默认 /home/ubuntu/sub2api-miao/docs/pixelsky-download/app，可以用 PIXELSKY_DOWNLOAD_APP_DIR 改。
// 需要本机能免密 ssh / scp 到那台机器。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'apps', 'app', 'build', 'dist')
const host = process.env.PIXELSKY_DOWNLOAD_SSH
const dir = process.env.PIXELSKY_DOWNLOAD_APP_DIR ?? '/home/ubuntu/sub2api-miao/docs/pixelsky-download/app'
const dry = process.argv.includes('--dry-run')

const fail = msg => {
  console.error(msg)
  process.exit(1)
}
if (!host) fail('要设环境变量 PIXELSKY_DOWNLOAD_SSH（例如 root@服务器地址）')
if (!/^\/[\w./-]+$/.test(dir) || dir.includes('..')) fail(`目录不对：${dir}`)

const manifestFile = join(dist, 'latest.json')
if (!existsSync(manifestFile)) fail(`没有 ${manifestFile}，先跑 node scripts/build-app.mjs`)
const m = JSON.parse(readFileSync(manifestFile, 'utf8'))
if (!/^[A-Za-z0-9._-]+\.apk$/.test(m.file ?? '')) fail(`latest.json 的 file 不对：${m.file}`)
if (!/^[0-9a-f]{64}$/.test(m.sha256 ?? '')) fail('latest.json 的 sha256 不对')
const apk = join(dist, m.file)
if (!existsSync(apk)) fail(`没有 ${apk}`)
const sha = createHash('sha256').update(readFileSync(apk)).digest('hex')
if (sha !== m.sha256 || statSync(apk).size !== m.size)
  fail('APK 和 latest.json 对不上（大小或 sha256），重新跑 build-app.mjs')

const run = (tool, args, cwd = root) =>
  new Promise((done, failed) => {
    if (dry) {
      console.log(`[dry-run] ${tool} ${args.join(' ')}`)
      return done('')
    }
    const child = spawn(tool, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.on('error', failed)
    child.on('close', code => (code === 0 ? done(out) : failed(new Error(`${tool} 退出码 ${code}`))))
  })
const ssh = script => run('ssh', [host, script])
const q = s => `'${s.replaceAll("'", `'\\''`)}'`

console.log(`传 ${m.file}（${m.version} +${m.build}，${(m.size / 1048576).toFixed(1)} MB）→ ${host}:${dir}`)
await ssh(`mkdir -p ${q(dir)}`)
// 在 dist 里用相对文件名：Windows 的 scp 会把 "D:" 当成主机名
await run('scp', [m.file, `${host}:${dir}/${m.file}.part`], dist)
const remote = (await ssh(`sha256sum ${q(`${dir}/${m.file}.part`)}`)).split(/\s/)[0]
if (!dry && remote !== sha) {
  await ssh(`rm -f ${q(`${dir}/${m.file}.part`)}`)
  fail(`服务器上的 sha256 对不上（${remote}），已删掉，没有换 latest.json`)
}
await ssh(`mv -f ${q(`${dir}/${m.file}.part`)} ${q(`${dir}/${m.file}`)}`)

await run('scp', ['latest.json', `${host}:${dir}/latest.json.part`], dist)
await ssh(
  [
    `cd ${q(dir)}`,
    // 旧的 latest.json 留一份用来回退
    `if [ -f latest.json ]; then cp -f latest.json latest.prev.json; fi`,
    `mv -f latest.json.part latest.json`,
    `chmod 644 latest.json ${q(m.file)}`,
    // 只留最新的两个 APK（按修改时间）
    `ls -1t -- *.apk | tail -n +3 | xargs -r rm -f --`,
  ].join(' && '),
)
console.log(dry ? '[dry-run] 结束' : `完成：https://pixelstarrysky.xyz/download/app/${m.file}`)
