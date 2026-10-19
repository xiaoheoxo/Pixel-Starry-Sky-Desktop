// 生成官方语言扩展的图标（extensions/official/AUTHORING.md §1）：和应用图标同一套配色——深色圆角方块、米白语言简称、右上一颗浅橙四角星。
// 用法（仓库根目录，环境里不能有 ELECTRON_RUN_AS_NODE）：pnpm --filter @pixelsky/desktop exec electron ../../extensions/official/scripts/make-icons.mjs
// 每个扩展写 <名字>/icon.png（256×256）。加新语言时在 LABELS 里加一行。
import { app, BrowserWindow } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LABELS = {
  python: 'Py',
  typescript: 'TS',
  go: 'Go',
  rust: 'Rs',
  java: 'Ja',
  cpp: 'C++',
  csharp: 'C#',
  kotlin: 'Kt',
}
const SIZE = 256

/** 在页面里画：圆角方块 + 简称（字号按字数缩）+ 右上小星 */
const draw = `(async jobs => {
  await document.fonts.ready
  const out = {}
  for (const [name, label] of jobs) {
    const S = ${SIZE}
    const c = Object.assign(document.createElement('canvas'), { width: S, height: S })
    const g = c.getContext('2d')
    const r = S * 0.236
    g.fillStyle = '#1d1915'
    g.beginPath(); g.roundRect(0, 0, S, S, r); g.fill()
    const size = label.length >= 3 ? S * 0.34 : S * 0.42
    g.font = '600 ' + size + 'px "Segoe UI", "SF Pro Display", "Helvetica Neue", Arial, sans-serif'
    g.fillStyle = '#f4efe8'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(label, S * 0.47, S * 0.56)
    // 四角星：中心、半径、内凹 0.2（和标志里的小星一样）
    const cx = S * 0.8, cy = S * 0.2, R = S * 0.085, q = R * 0.2
    g.fillStyle = '#f0a764'
    g.beginPath()
    g.moveTo(cx, cy - R)
    g.quadraticCurveTo(cx + q, cy - q, cx + R, cy)
    g.quadraticCurveTo(cx + q, cy + q, cx, cy + R)
    g.quadraticCurveTo(cx - q, cy + q, cx - R, cy)
    g.quadraticCurveTo(cx - q, cy - q, cx, cy - R)
    g.fill()
    out[name] = c.toDataURL('image/png').split(',')[1]
  }
  return out
})`

app.disableHardwareAcceleration()
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    await win.loadURL('about:blank')
    const jobs = Object.entries(LABELS).filter(([name]) => existsSync(join(root, name)))
    const pngs = await win.webContents.executeJavaScript(`${draw}(${JSON.stringify(jobs)})`)
    for (const [name] of jobs) writeFileSync(join(root, name, 'icon.png'), Buffer.from(pngs[name], 'base64'))
    console.log(`写好了 ${jobs.length} 个图标`)
    win.destroy()
    app.quit()
  })
  .catch(err => {
    console.error(err)
    app.exit(1)
  })
