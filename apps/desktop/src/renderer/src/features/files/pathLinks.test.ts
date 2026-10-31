import { beforeEach, describe, expect, it, vi } from 'vitest'

// remote 开头的会话 / 项目在远程机器上，其余在本机
vi.mock('@/features/machines/store', () => ({
  machineOf: (id?: string) => (id?.startsWith('remote') ? 'ssh-1' : 'local'),
  isWindowsMachine: (id: string) => id === 'local' && window.pixelsky?.platform === 'win32',
}))

// 项目根目录 D:/repo（会话的工作目录也是它）：文件 src/a.ts、README.md、build/reports/index.html、my dir/x.md；
// 名字带 / 结尾的是文件夹
const files: Record<string, string[]> = {
  '': ['README.md', 'src/', 'build/', 'my dir/'],
  src: ['a.ts'],
  build: ['reports/'],
  'build/reports': ['index.html'],
  'my dir': ['x.md'],
  // multi 开头的会话是多文件夹项目：附加文件夹 D:/shared（远程是 /shared）里有 src/a.ts
  '::1': ['src/'],
  '::1/src': ['a.ts'],
}
// 目录不存在时 listExisting 返回 null，不报错（报错的话主进程会把每一次都记成 ERROR）
const list = vi.fn(async (_ref: unknown, dir: string) =>
  files[dir]
    ? {
        entries: files[dir].map(raw => {
          const name = raw.replace(/\/$/, '')
          return { name, path: dir ? `${dir}/${name}` : name, kind: raw.endsWith('/') ? 'directory' : 'file' }
        }),
        truncated: false,
      }
    : null,
)
// 项目外：C:\elsewhere 是文件夹，C:\elsewhere\a.ts 是文件，其余不存在
const statOutside = vi.fn(async (path: string) =>
  path === 'C:\\elsewhere' ? 'folder' : path === 'C:\\elsewhere\\a.ts' ? 'file' : null,
)
vi.stubGlobal('window', {
  pixelsky: {
    platform: 'win32',
    files: {
      target: async (ref: { sessionId?: string }) =>
        ref.sessionId === 'remote-multi'
          ? { path: '/repo', folders: [{ path: '/shared' }] }
          : ref.sessionId?.startsWith('multi')
            ? { path: 'D:\\repo', folders: [{ path: 'D:\\shared' }] }
            : { path: 'D:\\repo' },
      listExisting: list,
    },
    editor: { statOutside },
  },
})

const { linkTarget, localAbsolute, splitLine, wholeTextFile, workspaceFilePath } = await import('./pathLinks')

describe('workspaceFilePath', () => {
  beforeEach(() => list.mockClear())

  it('相对路径、绝对路径、大小写不同（Windows）都找得到', async () => {
    const ref = { sessionId: 's1' }
    expect(await workspaceFilePath(ref, 'src/a.ts')).toBe('src/a.ts')
    expect(await workspaceFilePath(ref, './src/A.ts')).toBe('src/A.ts')
    expect(await workspaceFilePath(ref, 'D:\\repo\\README.md')).toBe('README.md')
  })

  it('不存在、在项目外的为 null', async () => {
    const ref = { sessionId: 's2' }
    expect(await workspaceFilePath(ref, 'src/missing.ts')).toBeNull()
    expect(await workspaceFilePath(ref, 'not/created/yet.ts')).toBeNull()
    expect(await workspaceFilePath(ref, '../other/a.ts')).toBeNull()
    expect(await workspaceFilePath(ref, 'C:/elsewhere/a.ts')).toBeNull()
  })

  it('同一个目录短时间内只读一次', async () => {
    const ref = { projectId: 'p-cache' }
    await workspaceFilePath(ref, 'src/a.ts')
    await workspaceFilePath(ref, 'src/b.ts')
    expect(list).toHaveBeenCalledTimes(1)
  })
})

describe('wholeTextFile', () => {
  it('整段是路径时给出文件和行列', async () => {
    expect(await wholeTextFile({ sessionId: 's3' }, 'src/a.ts:12:3')).toEqual({ path: 'src/a.ts', line: 12, column: 3 })
    expect(await wholeTextFile({ sessionId: 's3' }, 'README.md')).toEqual({
      path: 'README.md',
      line: null,
      column: null,
    })
  })

  it('file:/// 地址也认，#L 行号照样拆出来', async () => {
    const ref = { sessionId: 's3' }
    expect(await wholeTextFile(ref, 'file:///D:/repo/README.md')).toEqual({
      path: 'README.md',
      line: null,
      column: null,
    })
    expect(await wholeTextFile(ref, 'file:///D:/repo/src/a.ts#L12')).toEqual({
      path: 'src/a.ts',
      line: 12,
      column: null,
    })
    expect(await wholeTextFile(ref, 'file:///C:/elsewhere/a.ts')).toBeNull()
  })

  it('文字里还有别的内容时不算', async () => {
    expect(await wholeTextFile({ sessionId: 's3' }, 'see src/a.ts')).toBeNull()
    expect(await wholeTextFile({ sessionId: 's3' }, 'src/a.ts,')).toBeNull()
  })
})

// Markdown 链接的地址（docs/ui/path-click.md）：Codex 的「查看文件」这类链接原来因为盘符前多一个 /、
// 指向文件夹、路径带空格、在项目外，全都显示成不能点的文字
describe('linkTarget', () => {
  const ref = { sessionId: 's-link' }

  it('项目里的文件：完整路径、带空格、带行列都认', async () => {
    expect(await linkTarget(ref, 'D:/repo/build/reports/index.html')).toEqual({
      kind: 'file',
      path: 'build/reports/index.html',
      line: null,
      column: null,
    })
    expect(await linkTarget(ref, 'D:\\repo\\my dir\\x.md')).toEqual({
      kind: 'file',
      path: 'my dir/x.md',
      line: null,
      column: null,
    })
    expect(await linkTarget(ref, 'D:/repo/src/a.ts:12:3')).toEqual({
      kind: 'file',
      path: 'src/a.ts',
      line: 12,
      column: 3,
    })
    expect(await linkTarget(ref, 'README.md')).toMatchObject({ kind: 'file', path: 'README.md' })
  })

  it('项目里的文件夹', async () => {
    expect(await linkTarget(ref, 'D:/repo/build/reports')).toEqual({ kind: 'folder', path: 'build/reports' })
    expect(await linkTarget(ref, 'D:/repo/my dir/')).toEqual({ kind: 'folder', path: 'my dir' })
  })

  it('项目里不存在的为 null', async () => {
    expect(await linkTarget(ref, 'D:/repo/build/missing.html')).toBeNull()
    expect(await linkTarget(ref, 'D:/repo/nowhere')).toBeNull()
  })

  it('项目外：本机上存在的给完整路径（Windows 用 \\），不存在的为 null', async () => {
    expect(await linkTarget(ref, 'C:/elsewhere/a.ts')).toEqual({
      kind: 'outside',
      path: 'C:\\elsewhere\\a.ts',
      folder: false,
    })
    expect(await linkTarget(ref, 'C:\\elsewhere')).toEqual({ kind: 'outside', path: 'C:\\elsewhere', folder: true })
    expect(await linkTarget(ref, 'C:/missing/a.ts')).toBeNull()
  })

  it('网络路径、相对路径跑到项目外的不去问主进程', async () => {
    statOutside.mockClear()
    expect(await linkTarget(ref, '\\\\host\\share\\a.ts')).toBeNull()
    expect(await linkTarget(ref, '//host/share/a.ts')).toBeNull()
    expect(await linkTarget(ref, '../other/a.ts')).toBeNull()
    expect(statOutside).not.toHaveBeenCalled()
  })

  it('远程机器上的会话：项目外的路径不认（这台电脑上没法显示）', async () => {
    statOutside.mockClear()
    expect(await linkTarget({ sessionId: 'remote-1' }, 'C:/elsewhere/a.ts')).toBeNull()
    expect(statOutside).not.toHaveBeenCalled()
  })

  it('附加文件夹里的文件 / 文件夹也是项目里的：在内部编辑器打开，保留行列（#86）', async () => {
    statOutside.mockClear()
    const ref = { sessionId: 'multi-1' }
    expect(await linkTarget(ref, 'D:/shared/src/a.ts:12:3')).toEqual({
      kind: 'file',
      path: '::1/src/a.ts',
      line: 12,
      column: 3,
    })
    expect(await linkTarget(ref, 'D:\\shared\\src')).toEqual({ kind: 'folder', path: '::1/src' })
    expect(await linkTarget(ref, 'D:/repo/src/a.ts')).toMatchObject({ kind: 'file', path: 'src/a.ts' })
    expect(await linkTarget(ref, 'D:/shared/missing.ts')).toBeNull()
    expect(statOutside).not.toHaveBeenCalled()
  })

  it('远程会话也认附加文件夹里的文件（#86）', async () => {
    expect(await linkTarget({ sessionId: 'remote-multi' }, '/shared/src/a.ts:12')).toEqual({
      kind: 'file',
      path: '::1/src/a.ts',
      line: 12,
      column: null,
    })
  })
})

describe('splitLine / localAbsolute', () => {
  it('末尾的 :行:列 拆出来，盘符的冒号不拆', () => {
    expect(splitLine('E:/a b/c.ts:7:2')).toEqual({ path: 'E:/a b/c.ts', line: 7, column: 2 })
    expect(splitLine('E:/x')).toEqual({ path: 'E:/x', line: null, column: null })
  })
  it('本机完整路径：Windows 要盘符，其余 / 开头，网络路径不算', () => {
    expect(localAbsolute('E:/x', true)).toBe(true)
    expect(localAbsolute('\\\\host\\x', true)).toBe(false)
    expect(localAbsolute('/home/a', false)).toBe(true)
    expect(localAbsolute('//host/a', false)).toBe(false)
  })
})
