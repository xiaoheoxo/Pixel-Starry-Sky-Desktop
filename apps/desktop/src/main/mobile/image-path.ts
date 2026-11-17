// 手机看回复里的图（docs/mobile-app.md §15.17）：Markdown 图片地址 → 项目里的相对路径。
// 同窗口 ui/markdown/pathLinks.tsx 的 linkPathText（不认锚点）+ features/files/pathMatch.ts 的 projectPath
// + 多文件夹「::N/…」（features/files/pathLinks.ts workspaceRelativePath）；相对路径按工作目录根算。
// 项目外的、带 .. 越界的、网址都返回 null：手机只能读这个会话项目里的文件（「::0/完整路径」不给手机）。

const slash = (p: string): string => p.replaceAll('\\', '/')

function normalize(path: string): string | null {
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? ''
  const rest = path.slice(drive.length)
  const absolute = rest.startsWith('/')
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return drive + (absolute ? '/' : '') + parts.join('/')
}

/** Markdown 图片地址里的本地路径；网址、锚点返回 null */
export function imageSrcPath(src: string): string | null {
  if (!src || src.startsWith('#') || src.startsWith('//')) return null
  let value = src
  if (/^file:/i.test(value)) value = value.replace(/^file:\/*/i, /^file:\/*[A-Za-z]:/i.test(value) ? '' : '/')
  else if (/^[a-z][\w+.-]*:/i.test(value) && !/^[A-Za-z]:(?:[\\/]|%5C)/i.test(value)) return null
  try {
    value = decodeURIComponent(value)
  } catch {
    /* 不是合法的 % 编码：原样 */
  }
  // /E:/x/a.png：Codex 给 Windows 绝对路径前面多加的 /
  value = value.replace(/^\/(?=[A-Za-z]:[\\/])/, '')
  // 「::N/…」是电脑文件接口的文件夹记号（::0 是项目外的完整路径），不能从图片地址里带进来
  if (value.startsWith('::')) return null
  return value || null
}

function inside(raw: string, root: string, windows: boolean): string | null {
  const input = slash(raw)
  const absolute = /^[A-Za-z]:\//.test(input) || input.startsWith('/')
  const full = normalize(absolute ? input : slash(root).replace(/\/$/, '') + '/' + input)
  const base = normalize(slash(root).replace(/\/$/, ''))
  if (!full || !base) return null
  const prefix = full.slice(0, base.length)
  if (!(windows ? prefix.toLowerCase() === base.toLowerCase() : prefix === base) || full[base.length] !== '/')
    return null
  const relative = full.slice(base.length + 1)
  // 「./::0/x」规整后又成了 ::0/x：同样不给
  return relative && !relative.startsWith('::') && !relative.split('/').includes('..') ? relative : null
}

/** 图片地址 → 项目里的路径（主文件夹不带前缀，附加文件夹「::N/…」）；不在项目里返回 null */
export function phoneImagePath(src: string, target: { path: string; folders?: { path: string }[] }): string | null {
  const raw = imageSrcPath(src)
  if (!raw) return null
  const windows = /^[A-Za-z]:/.test(target.path)
  const main = inside(raw, target.path, windows)
  if (main) return main
  for (const [i, folder] of (target.folders ?? []).entries()) {
    const found = inside(raw, folder.path, windows)
    if (found) return `::${i + 1}/${found}`
  }
  return null
}
