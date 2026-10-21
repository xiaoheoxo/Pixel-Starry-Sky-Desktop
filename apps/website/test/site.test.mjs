// 官网测试（node:test，无依赖）：纯函数、英文文案是否齐全、构建产物里的链接和占位。
// 运行：node --test apps/website/test/site.test.mjs  （node scripts/check.mjs 的 test:website 也跑这个）
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..')
const repo = resolve(app, '..', '..')
const src = join(app, 'src')
const read = p => readFileSync(join(src, p), 'utf8')

const ctx = {}
vm.runInNewContext(read('lib.js') + '\n' + read('i18n.js'), ctx)
const { PLATFORMS, detect, fileOf, fromGitHub, headline, md } = ctx.PSLib
const { EN, FAQ } = ctx.PSText

describe('lib', () => {
  test('md：标题、两级列表、粗体、代码，HTML 先转义', () => {
    assert.equal(
      md('## 🆕 新功能\n\n- **A**：说明\n  - 子项 `x<y`\n- B'),
      '<h2>🆕 新功能</h2><ul><li><b>A</b>：说明</li><ul><li>子项 <code>x&lt;y</code></li></ul><li>B</li></ul>',
    )
    assert.equal(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    assert.equal(md('- "a" & b'), '<ul><li>&quot;a&quot; &amp; b</li></ul>')
    assert.equal(md(''), '')
  })

  test('headline：取第一条加粗要点，去掉末尾冒号', () => {
    assert.equal(
      headline('## 🆕 新功能\n\n- **Claude Code 账号多开，一键切换**：和 ChatGPT…\n- **B**'),
      'Claude Code 账号多开，一键切换',
    )
    assert.equal(headline('## 修复\n\n- 普通一条'), null)
  })

  test('detect：按系统和显卡认安装包', () => {
    const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    assert.equal(detect({ userAgent: win, platform: 'Windows' }), 'win')
    assert.equal(
      detect({ userAgent: mac, platform: 'macOS', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2)' }),
      'mac-arm',
    )
    assert.equal(
      detect({ userAgent: mac, platform: 'MacIntel', renderer: 'ANGLE (Intel Inc., Intel Iris Pro)' }),
      'mac-x64',
    )
    assert.equal(detect({ userAgent: mac, platform: 'MacIntel' }), 'mac-arm')
    assert.equal(detect({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64' }), 'appimage')
    // 手机先不放安装包，按钮给 Windows 版（页面上还有其他系统）
    assert.equal(detect({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: 'Linux armv8l' }), 'win')
  })

  test('fileOf：认得 electron-builder 的五种安装包名，blockmap / yml 在 fromGitHub 里去掉', () => {
    const [rel] = fromGitHub(
      [
        {
          tag_name: 'v9.9.9',
          published_at: '2026-10-21T00:00:00Z',
          body: '',
          assets: [
            'PixelSky-9.9.9-setup.exe',
            'PixelSky-9.9.9-setup.exe.blockmap',
            'latest.yml',
            'PixelSky-9.9.9-mac-arm64.dmg',
            'PixelSky-9.9.9-mac-arm64.zip',
            'PixelSky-9.9.9-mac-x64.dmg',
            'PixelSky-9.9.9-linux-x86_64.AppImage',
            'PixelSky-9.9.9-linux-amd64.deb',
          ].map(name => ({ name, size: 1048576 })),
        },
        { tag_name: 'v9.9.8', draft: true, assets: [] },
        { tag_name: 'v9.9.8-beta', prerelease: true, assets: [] },
      ].concat([]),
    )
    assert.equal(rel.tag, 'v9.9.9')
    assert.equal(rel.date, '2026-10-21')
    assert.ok(!rel.assets.some(([n]) => /blockmap|yml$/.test(n)))
    assert.deepEqual(
      Object.keys(PLATFORMS).map(k => fileOf(rel, k)?.[0]),
      [
        'PixelSky-9.9.9-setup.exe',
        'PixelSky-9.9.9-mac-arm64.dmg',
        'PixelSky-9.9.9-mac-x64.dmg',
        'PixelSky-9.9.9-linux-x86_64.AppImage',
        'PixelSky-9.9.9-linux-amd64.deb',
      ],
    )
  })
})

describe('文案', () => {
  test('页面里每个 data-i / data-i-html 都有英文', () => {
    const files = [
      ...readdirSync(join(src, 'pages')).map(f => `pages/${f}`),
      ...readdirSync(join(src, 'partials')).map(f => `partials/${f}`),
    ]
    const missing = []
    for (const f of files)
      for (const [, k] of read(f).matchAll(/data-i(?:-html)?="([^"]+)"/g)) if (!(k in EN)) missing.push(`${f}: ${k}`)
    assert.deepEqual(missing, [])
  })

  test('常见问题中英条数一样', () => assert.equal(FAQ.zh.length, FAQ.en.length))
})

describe('构建', () => {
  const out = join(repo, 'scratch', `website-test-${process.pid}`)
  after(() => rmSync(out, { recursive: true, force: true }))

  test('四个页面都生成，没有占位，站内链接和资源都在', () => {
    mkdirSync(dirname(out), { recursive: true })
    execFileSync(
      process.execPath,
      [join(app, 'scripts', 'build.mjs'), '--offline', '--out', out, '--base', '/download/'],
      { stdio: 'pipe' },
    )
    const pages = ['index.html', 'features/index.html', 'changelog/index.html', 'help/index.html']
    const broken = []
    for (const p of pages) {
      const html = readFileSync(join(out, p), 'utf8')
      assert.ok(!/\{\{\w+\}\}|<!-- @\w+ -->/.test(html), `${p} 还有占位`)
      assert.ok(html.includes('id="ps-releases"'), `${p} 缺版本数据`)
      for (const [, url] of html.matchAll(/(?:href|src|data-dark|data-light)="(\/download\/[^"#]*)/g)) {
        const rel = url.slice('/download/'.length)
        const file = join(out, rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel)
        if (!existsSync(file)) broken.push(`${p} → ${url}`)
      }
      // 版本数据能解析，正文里的 </script> 不会提前结束标签
      const json = html.match(/<script type="application\/json" id="ps-releases">([\s\S]*?)<\/script>/)[1]
      assert.ok(Array.isArray(JSON.parse(json)))
    }
    assert.deepEqual(broken, [])
  })
})
