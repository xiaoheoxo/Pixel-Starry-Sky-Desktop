// 重新导出手机 App（apps/app）的共用测试样例（docs/mobile-app.md §5.2）：
// 用 packages/link（加密通道）和 packages/protocol（会话折叠等纯函数）的 TS 实现算出结果，
// 写到 apps/app/test/fixtures/，Dart 测试读它们逐项比对。
// 用法：node scripts/export-app-fixtures.mjs（改了这两个包之后运行，再到 apps/app 跑 flutter test）
// 平时 node scripts/check.mjs 里的 test:link、test:protocol 只比较，样例不是最新就失败。直接调 vitest，不经过 pnpm（同 check.mjs）
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, APP_FIXTURES_UPDATE: '1' }
delete env.ELECTRON_RUN_AS_NODE

const run = dir =>
  new Promise(done => {
    const child = spawn(
      process.execPath,
      [join(dir, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'test/app-fixtures.test.ts', '--testTimeout=60000'],
      { cwd: dir, env, stdio: 'inherit' },
    )
    child.on('error', error => {
      console.error(String(error))
      done(1)
    })
    child.on('close', code => done(code ?? 1))
  })

for (const pkg of ['link', 'protocol']) {
  const code = await run(join(root, 'packages', pkg))
  if (code !== 0) process.exit(code)
}
console.log('已写入 apps/app/test/fixtures/：到 apps/app 跑 flutter test 核对 Dart 实现')
