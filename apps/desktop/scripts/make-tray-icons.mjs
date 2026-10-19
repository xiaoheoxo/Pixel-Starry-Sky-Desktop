// 生成托盘图标（docs/ui/tray.md §2.5）：把 build/icon.png（scripts/make-brand-icons.mjs 画的方块标）缩小到托盘用的几种尺寸，运行中 / 等你处理在右下角加圆点，
// 圆点外留一圈透明缝（深色、浅色任务栏上都分得清），写成多尺寸 .ico（Windows）和 PNG（其他平台）。
// 用法：pnpm --filter @pixelsky/desktop exec electron scripts/make-tray-icons.mjs（环境里不能有 ELECTRON_RUN_AS_NODE，空值也不行）
// 结果入库在 build/tray/，打包时由 electron-builder.yml 的 extraResources 带进 resources/tray。
import { app, nativeImage } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ico } from './ico.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'build/tray')
const SIZES = [16, 20, 24, 32, 40, 48]
const VARIANTS = {
  tray: null,
  'tray-running': [0x2f, 0xb3, 0x7e],
  'tray-attention': [0xe5, 0x48, 0x4d],
}

/** 在 BGRA 位图右下角画一个抗锯齿圆点，外圈挖透明缝 */
function badge(bitmap, size, rgb) {
  const r = size * 0.2
  const gap = Math.max(1, size / 16)
  const cx = size - r - size * 0.02
  const cy = size - r - size * 0.02
  const SS = 4
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let dot = 0,
        hole = 0
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const d = Math.hypot(x + (sx + 0.5) / SS - cx, y + (sy + 0.5) / SS - cy)
          if (d <= r) dot++
          else if (d <= r + gap) hole++
        }
      const i = (y * size + x) * 4
      const cover = dot / (SS * SS),
        clear = hole / (SS * SS)
      // 透明缝：把原图按覆盖率擦掉
      bitmap[i + 3] = Math.round(bitmap[i + 3] * (1 - clear - cover))
      if (cover > 0) {
        // 预乘 alpha：圆点叠在剩下的原图上
        const keep = 1 - cover
        bitmap[i] = Math.round(bitmap[i] * keep + rgb[2] * cover)
        bitmap[i + 1] = Math.round(bitmap[i + 1] * keep + rgb[1] * cover)
        bitmap[i + 2] = Math.round(bitmap[i + 2] * keep + rgb[0] * cover)
        bitmap[i + 3] = Math.round(bitmap[i + 3] + 255 * cover)
      }
    }
}

app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(join(root, 'build/icon.png'))
  if (icon.isEmpty()) throw new Error('读不到 build/icon.png')
  mkdirSync(out, { recursive: true })
  const frame = (size, rgb) => {
    const img = icon.resize({ width: size, height: size, quality: 'best' })
    const bitmap = Buffer.from(img.toBitmap())
    if (rgb) badge(bitmap, size, rgb)
    return nativeImage.createFromBitmap(bitmap, { width: size, height: size }).toPNG()
  }
  for (const [name, rgb] of Object.entries(VARIANTS)) {
    writeFileSync(join(out, `${name}.ico`), ico(SIZES.map(size => ({ size, png: frame(size, rgb) }))))
    // macOS / Linux：16px 一倍图 + 32px 二倍图
    writeFileSync(join(out, `${name}.png`), frame(16, rgb))
    writeFileSync(join(out, `${name}@2x.png`), frame(32, rgb))
  }
  // 任务栏按钮上的红点（setOverlayIcon，16px 显示，给 32px 留缩放余地）
  const dot = Buffer.alloc(32 * 32 * 4)
  badge(dot, 32, VARIANTS['tray-attention'])
  // 只要圆点：badge 在全透明底上画，透明缝不影响
  writeFileSync(
    join(out, 'overlay-attention.png'),
    nativeImage.createFromBitmap(dot, { width: 32, height: 32 }).toPNG(),
  )
  console.log('写好了', out)
  app.quit()
})
