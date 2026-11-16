import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { imageMediaType, MAX_IMAGE_BYTES, type ImageAttachment } from '@pixelsky/protocol'

/** 看图结果随条目保存：图片可能在项目外，临时文件也可能在稍后被清理。只读 Codex 已完成的看图路径。 */
export function codexViewedImage(path: string, id: string, cwd?: string): ImageAttachment | null {
  if (!path || path.includes('\0') || /^[\\/]{2}/.test(path) || (!isAbsolute(path) && !cwd)) return null
  const file = resolve(cwd ?? '.', path)
  // 相对路径也不能借工作目录落到网络共享。
  if (/^[\\/]{2}/.test(file)) return null
  let fd: number | undefined
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) return null
    // 固定分配上限，即使文件在检查后增长也不会无限读取；中途被截断则放弃。
    const data = Buffer.alloc(info.size)
    let offset = 0
    while (offset < data.length) {
      const read = readSync(fd, data, offset, data.length - offset, offset)
      if (!read) return null
      offset += read
    }
    const mediaType = imageMediaType(data)
    if (!mediaType) return null
    return {
      id: `${id}-img0`,
      name: basename(file),
      mediaType,
      bytes: data.length,
      width: 0,
      height: 0,
      dataBase64: data.toString('base64'),
    }
  } catch {
    // 文件已被清理、格式不支持或读不到：保留原来的路径条目，不影响这一轮继续。
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Codex 内置生图工具的结果（app-server 的 imageGeneration 条目，docs/ui/image-gen.md）：
 * 优先读 Codex 存到本地的 savedPath（绝对路径），没有时用条目里的 base64（result）。超过上限、认不出格式的不要
 */
export function codexGeneratedImage(
  raw: { savedPath?: unknown; result?: unknown },
  id: string,
): ImageAttachment | null {
  const saved =
    typeof raw.savedPath === 'string' && isAbsolute(raw.savedPath) ? codexViewedImage(raw.savedPath, id) : null
  if (saved) return saved
  const b64 = typeof raw.result === 'string' ? raw.result.replace(/^data:[^,]*,/, '') : ''
  // base64 每 4 个字符 3 个字节：先按长度挡掉超大的，不解出来
  if (!b64 || (b64.length / 4) * 3 > MAX_IMAGE_BYTES) return null
  const data = Buffer.from(b64, 'base64')
  const mediaType = data.length ? imageMediaType(data) : null
  if (!mediaType) return null
  return {
    id: `${id}-img0`,
    name: `image.${mediaType.slice(6).replace('jpeg', 'jpg')}`,
    mediaType,
    bytes: data.length,
    width: 0,
    height: 0,
    dataBase64: data.toString('base64'),
  }
}

/** 生图失败的原因（ImageGenerationFailure）：目前只有额度用完一种；resetsAt 是秒 */
export function codexGenerationFailure(failure: unknown, now = Date.now()): string {
  if (!failure || typeof failure !== 'object') return ''
  const f = failure as { type?: unknown; resetsAt?: unknown }
  if (f.type !== 'usageLimitExceeded') return `生图失败（${String(f.type ?? '未知原因')}）`
  const at = typeof f.resetsAt === 'number' && f.resetsAt > 0 ? new Date(f.resetsAt * 1000) : null
  if (!at) return '生图额度用完了'
  const sameDay = new Date(now).toDateString() === at.toDateString()
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return `生图额度用完了，${sameDay ? '今天 ' : `${at.getMonth() + 1} 月 ${at.getDate()} 日 `}${time} 恢复`
}
