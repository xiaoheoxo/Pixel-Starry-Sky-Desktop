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
