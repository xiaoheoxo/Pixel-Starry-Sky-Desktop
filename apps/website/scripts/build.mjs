// 官网构建（无依赖）：把顶栏、页脚、图标写进四个页面，样式和脚本带内容哈希，嵌入兜底的版本数据。
// 用法：node apps/website/scripts/build.mjs [--out <目录>] [--base /download/] [--offline] [--update-fallback]
//   --offline          不读 GitHub，直接用 src/fallback.json
//   --update-fallback  读到 GitHub 后，把最新一版写回 src/fallback.json（发版后顺手更新，提交进仓库）
// 走代理时加 NODE_USE_ENV_PROXY=1（和 packages/cli/scripts/tools.mjs 一样）。
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const src = join(root, 'src')
const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const out = resolve(opt('--out') || join(root, 'dist'))
const base = opt('--base') || '/download/'
if (!/^\/([\w.-]+\/)*$/.test(base)) throw new Error(`--base 要以 / 开头和结尾：${base}`)

export const REPO = 'xiaoheoxo/Pixel-Starry-Sky-Desktop'
/** 页面：源文件 → 输出路径（目录下的 index.html，地址不带 .html） */
export const PAGES = [
  { file: 'index.html', out: 'index.html' },
  { file: 'features.html', out: 'features/index.html' },
  { file: 'changelog.html', out: 'changelog/index.html' },
  { file: 'help.html', out: 'help/index.html' },
]

const read = p => readFileSync(join(src, p), 'utf8')
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 10)

/** lib.js 在 node 里也能跑：取 fromGitHub，和页面用同一份转换 */
function lib() {
  const ctx = {}
  vm.runInNewContext(read('lib.js'), ctx)
  return ctx.PSLib
}

async function releases() {
  const fallback = JSON.parse(read('fallback.json'))
  if (args.includes('--offline')) return { list: fallback, from: 'src/fallback.json' }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pixelsky-website-build' },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = lib().fromGitHub(await res.json())
    if (!list.length) throw new Error('没有已发布的版本')
    if (args.includes('--update-fallback'))
      writeFileSync(join(src, 'fallback.json'), JSON.stringify([list[0]], null, 2) + '\n')
    return { list, from: 'GitHub' }
  } catch (e) {
    console.warn(`[website] 读 GitHub 失败（${e.message}），用 src/fallback.json`)
    return { list: fallback, from: 'src/fallback.json' }
  }
}

/** 写进 <script type="application/json">：转义 <，防止正文里的 </script> 提前结束标签 */
const jsonScript = data =>
  `<script type="application/json" id="ps-releases">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`

export async function build() {
  const { list, from } = await releases()
  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'assets'), { recursive: true })

  const css = read('site.css')
  const js = ['lib.js', 'i18n.js', 'site.js'].map(read).join('\n')
  const cssName = `assets/site.${hash(css)}.css`
  const jsName = `assets/site.${hash(js)}.js`
  writeFileSync(join(out, cssName), css)
  writeFileSync(join(out, jsName), js)
  cpSync(join(src, 'assets'), join(out, 'assets'), { recursive: true })

  const parts = {
    head: read('partials/head.html').trim(),
    nav: (read('partials/sprite.html') + read('partials/nav.html')).trim(),
    foot: read('partials/foot.html').trim() + '\n    {{releases}}\n    <script src="{{js}}"></script>',
  }
  for (const page of PAGES) {
    let html = read(`pages/${page.file}`)
    for (const [k, v] of Object.entries(parts)) {
      if (!html.includes(`<!-- @${k} -->`)) throw new Error(`${page.file} 缺少 <!-- @${k} -->`)
      html = html.replace(`<!-- @${k} -->`, () => v)
    }
    // 更新说明页带全部版本，其它页只带最新一版（下载按钮用）
    const data = page.file === 'changelog.html' ? list : list.slice(0, 1)
    const latest = list[0]
    html = html
      .replace('{{releases}}', () => jsonScript(data))
      .replaceAll('{{tag}}', esc(latest?.tag ?? ''))
      .replaceAll('{{date}}', esc(latest?.date ?? ''))
      .replaceAll('{{headline}}', esc((latest && lib().headline(latest.body)) || ''))
      .replaceAll('{{css}}', base + cssName)
      .replaceAll('{{js}}', base + jsName)
      .replaceAll('{{base}}', base)
    if (/\{\{\w+\}\}/.test(html)) throw new Error(`${page.file} 还有没替换的占位：${html.match(/\{\{\w+\}\}/)[0]}`)
    mkdirSync(dirname(join(out, page.out)), { recursive: true })
    writeFileSync(join(out, page.out), html)
  }
  return { out, base, from, versions: list.length, latest: list[0]?.tag }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await build()
  console.log(`[website] ${r.out}（地址前缀 ${r.base}，版本数据来自 ${r.from}：${r.versions} 个，最新 ${r.latest}）`)
}
