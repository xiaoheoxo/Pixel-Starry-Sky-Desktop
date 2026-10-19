// 检查构建出来的主进程包（electron-vite build 的输出目录）：用法 node scripts/check-main-bundle.mjs <buildDir>
// - <buildDir>/main/index.js 以及它引用的分块里不能有语法引擎（OnigScanner / vscode-textmate）：语法检查只在检查进程里跑，
//   主进程带上它会多出几百 KB，也违背 eslint 里「main 不得导入 extension-cli 的 grammar / check」那条规则；
// - <buildDir>/main/ext-check.js 必须存在，而且有语法引擎（没有就是检查进程打包错了）。
// scripts/check.mjs 的 build 步骤在删掉输出目录之前调用它。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const FORBIDDEN = [/OnigScanner/, /vscode-textmate/]

const dir = process.argv[2]
if (!dir) {
  console.error('用法：node scripts/check-main-bundle.mjs <buildDir>')
  process.exit(2)
}
const main = join(resolve(dir), 'main')
const errors = []

/** index.js 直接 / 间接 require 的相对路径分块（electron-vite 输出 CJS） */
function reachable(entry) {
  const seen = new Set()
  const walk = file => {
    if (seen.has(file) || !existsSync(file)) return
    seen.add(file)
    for (const m of readFileSync(file, 'utf8').matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
      walk(resolve(dirname(file), m[1]))
    }
  }
  walk(entry)
  return [...seen]
}

const index = join(main, 'index.js')
if (!existsSync(index)) {
  errors.push(`没有 ${index}`)
} else {
  for (const file of reachable(index)) {
    const text = readFileSync(file, 'utf8')
    for (const re of FORBIDDEN) {
      if (re.test(text)) errors.push(`主进程包里有语法引擎（${re.source}）：${file}`)
    }
  }
}

const check = join(main, 'ext-check.js')
if (!existsSync(check)) {
  errors.push(`没有 ${check}（检查进程没打出来）`)
} else {
  const text = readFileSync(check, 'utf8')
  for (const re of FORBIDDEN) {
    if (!re.test(text)) errors.push(`检查进程包里没有 ${re.source}：${check}`)
  }
}

if (errors.length) {
  for (const e of errors) console.error(e)
  process.exit(1)
}
console.log('main bundle ok')
