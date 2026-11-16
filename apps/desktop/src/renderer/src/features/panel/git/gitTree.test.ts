// 更改页分组、筛选、排序（docs/ui/git-panel.md §10、§10.1）
import { describe, expect, it } from 'vitest'
import type { GitCode, GitFileChange, GitModule } from '../../../../../shared/types/project-tools'
import {
  AUTO_COLLAPSE,
  DEFAULT_GIT_VIEW,
  ancestorKeys,
  filterFiles,
  folderLocal,
  gitRows,
  gitViewPrefs,
  highlight,
  moduleOf,
  rowKey,
  sortFiles,
  statusCounts,
  sumStats,
  withRootModule,
  type GitRow,
  type GitRowOptions,
} from './gitTree'

const f = (path: string, code: GitCode = 'M', ins?: number, del?: number): GitFileChange => ({
  path,
  origPath: null,
  code,
  local: path,
  submodule: false,
  ...(ins === undefined ? {} : { insertions: ins, deletions: del ?? 0 }),
})
const modules: GitModule[] = withRootModule(
  [
    { dir: 'apps/desktop', name: '@pixelsky/desktop', kind: 'npm' },
    { dir: 'apps/app', name: 'pixelsky_app', kind: 'Flutter' },
  ],
  'PixelSky',
)
const opts = (
  o: Omit<Partial<GitRowOptions>, 'view'> & { view?: Partial<GitRowOptions['view']> } = {},
): GitRowOptions => ({
  modules,
  collapsed: new Set(),
  expanded: new Set(),
  filtering: false,
  staged: new Set(),
  ...o,
  view: { ...DEFAULT_GIT_VIEW, ...o.view },
})
/** 行的简写：缩进 + 名字（分组行带 /，模块带 @） */
const show = (rows: GitRow[]) =>
  rows.map(r =>
    r.type === 'file'
      ? '  '.repeat(r.depth) + r.file.path.slice(r.file.path.lastIndexOf('/') + 1) + (r.dir ? ` (${r.dir})` : '')
      : '  '.repeat(r.depth) +
        (r.group === 'module' ? '@' : '') +
        r.label +
        (r.group === 'folder' ? '/' : '') +
        (r.collapsed ? ' +' : ''),
  )

describe('查看方式', () => {
  it('存着的值逐项检查，不认识的用默认', () => {
    expect(gitViewPrefs(null)).toEqual(DEFAULT_GIT_VIEW)
    expect(gitViewPrefs({ dir: false, mod: 'yes', sort: 'size', stats: false })).toEqual({
      ...DEFAULT_GIT_VIEW,
      dir: false,
      stats: false,
    })
    expect(gitViewPrefs({ sort: 'lines' }).sort).toBe('lines')
  })
})

describe('筛选', () => {
  const files = [f('a/x.ts', 'M'), f('a/y.ts', 'A'), f('b/z.ts', 'D'), f('apps/app/lib/m.dart', '?'), f('c.ts', 'U')]
  it('状态分类和计数；冲突只算在全部里', () => {
    expect(statusCounts(files)).toEqual({ all: 5, modified: 1, added: 2, deleted: 1 })
  })
  it('文字（不分大小写）、状态、只看文件夹 / 模块', () => {
    const paths = (filter: Parameters<typeof filterFiles>[1]) => filterFiles(files, filter, modules).map(x => x.path)
    expect(paths({ text: ' X.T ', status: 'all', focus: null })).toEqual(['a/x.ts'])
    expect(paths({ text: '', status: 'added', focus: null })).toEqual(['a/y.ts', 'apps/app/lib/m.dart'])
    expect(paths({ text: '', status: 'all', focus: { kind: 'folder', path: 'a', label: 'a' } })).toEqual([
      'a/x.ts',
      'a/y.ts',
    ])
    expect(paths({ text: '', status: 'all', focus: { kind: 'module', path: 'apps/app', label: 'app' } })).toEqual([
      'apps/app/lib/m.dart',
    ])
    // 根模块不含子模块里的文件
    expect(paths({ text: '', status: 'all', focus: { kind: 'module', path: '', label: 'PixelSky' } })).toEqual([
      'a/x.ts',
      'a/y.ts',
      'b/z.ts',
      'c.ts',
    ])
  })
  it('模块取最长前缀；apps/application 不算 apps/app 里的', () => {
    expect(moduleOf('apps/app/lib/a.dart', modules).name).toBe('pixelsky_app')
    expect(moduleOf('apps/application/a', modules).name).toBe('PixelSky')
    expect(withRootModule([{ dir: '', name: 'root', kind: 'npm' }], 'X')).toHaveLength(1)
  })
  it('高亮所有匹配的段', () => {
    expect(highlight('GitPanel.git.ts', 'git')).toEqual([
      { text: 'Git', hit: true },
      { text: 'Panel.', hit: false },
      { text: 'git', hit: true },
      { text: '.ts', hit: false },
    ])
    expect(highlight('abc', ' ')).toEqual([{ text: 'abc', hit: false }])
  })
})

describe('行数和排序', () => {
  it('合计；一个都没有是 null', () => {
    expect(sumStats([f('a', 'M', 3, 1), f('b', '?'), f('c', 'M', 2)])).toEqual({ insertions: 5, deletions: 1 })
    expect(sumStats([f('a', '?')])).toBeNull()
  })
  it('名称 / 状态 / 行数', () => {
    const files = [f('z/a.ts', 'A', 1), f('b.ts', 'M', 10, 5), f('a/c.ts', 'D', 0, 3)]
    expect(sortFiles(files, 'name').map(x => x.path)).toEqual(['z/a.ts', 'b.ts', 'a/c.ts'])
    expect(sortFiles(files, 'name', true).map(x => x.path)).toEqual(['a/c.ts', 'b.ts', 'z/a.ts'])
    expect(sortFiles(files, 'status').map(x => x.path)).toEqual(['a/c.ts', 'b.ts', 'z/a.ts'])
    expect(sortFiles(files, 'lines').map(x => x.path)).toEqual(['b.ts', 'a/c.ts', 'z/a.ts'])
  })
})

describe('行', () => {
  const files = [
    f('README.md'),
    f('apps/desktop/src/main/a.ts'),
    f('apps/desktop/src/main/b.ts'),
    f('apps/desktop/package.json'),
    f('apps/app/lib/x.dart'),
  ]

  it('目录树：单子文件夹合并成一行，文件夹在前', () => {
    expect(show(gitRows('unstaged', files, opts()))).toEqual([
      'apps/',
      '  app/lib/',
      '    x.dart',
      '  desktop/',
      '    src/main/',
      '      a.ts',
      '      b.ts',
      '    package.json',
      'README.md',
    ])
    expect(show(gitRows('unstaged', files, opts({ view: { compact: false } }))).slice(0, 3)).toEqual([
      'apps/',
      '  app/',
      '    lib/',
    ])
  })

  it('平铺：完整路径排序，文件后带目录', () => {
    expect(show(gitRows('unstaged', files, opts({ view: { dir: false } })))).toEqual([
      'README.md',
      'x.dart (apps/app/lib)',
      'package.json (apps/desktop)',
      'a.ts (apps/desktop/src/main)',
      'b.ts (apps/desktop/src/main)',
    ])
  })

  it('按模块 + 目录；只有一个模块时不画模块这一层', () => {
    expect(show(gitRows('unstaged', files, opts({ view: { mod: true } })))).toEqual([
      '@PixelSky',
      '  README.md',
      '@pixelsky_app',
      '  lib/',
      '    x.dart',
      '@@pixelsky/desktop',
      '  src/main/',
      '    a.ts',
      '    b.ts',
      '  package.json',
    ])
    const one = withRootModule([], 'PixelSky')
    expect(show(gitRows('unstaged', files, opts({ modules: one, view: { mod: true } })))[0]).toBe('apps/')
  })

  it('只按模块：模块里平铺，文件带模块内的目录', () => {
    expect(show(gitRows('unstaged', files, opts({ view: { mod: true, dir: false } }))).slice(2, 4)).toEqual([
      '@pixelsky_app',
      '  x.dart (lib)',
    ])
  })

  it('收起的不画子行；文件多的默认收起，点开过或在筛选时展开', () => {
    const key = rowKey.folder('unstaged', 'apps/desktop')
    expect(show(gitRows('unstaged', files, opts({ collapsed: new Set([key]) })))).toEqual([
      'apps/',
      '  app/lib/',
      '    x.dart',
      '  desktop/ +',
      'README.md',
    ])
    const many = Array.from({ length: AUTO_COLLAPSE + 1 }, (_, i) => f(`gen/f${i}.ts`))
    const big = gitRows('unstaged', many, opts())
    expect(big).toHaveLength(1)
    expect(big[0]).toMatchObject({ collapsed: true, auto: true })
    const gen = rowKey.folder('unstaged', 'gen')
    expect(gitRows('unstaged', many, opts({ expanded: new Set([gen]) }))).toHaveLength(AUTO_COLLAPSE + 2)
    expect(gitRows('unstaged', many, opts({ filtering: true, collapsed: new Set([gen]) }))).toHaveLength(
      AUTO_COLLAPSE + 2,
    )
  })

  it('未跟踪的构建输出建议忽略到那一层；部分已暂存', () => {
    const rows = gitRows('untracked', [f('apps/app/build/x/a.js', '?'), f('src/a.ts', '?')], opts())
    expect(rows.filter(r => r.type === 'group').map(r => [r.label, r.type === 'group' && r.ignore])).toEqual([
      ['apps/app/build/x', 'apps/app/build'],
      ['src', null],
    ])
    expect(gitRows('unstaged', [f('build/a.js')], opts())[0]).toMatchObject({ ignore: null })
    const partial = gitRows('unstaged', [f('a.ts')], opts({ staged: new Set(['a.ts']) }))
    expect(partial[0]).toMatchObject({ partial: true })
  })

  it('行数排序：文件夹也按合计行数', () => {
    const rows = gitRows('unstaged', [f('a/x.ts', 'M', 1), f('b/y.ts', 'M', 9)], opts({ view: { sort: 'lines' } }))
    expect(show(rows)).toEqual(['b/', '  y.ts', 'a/', '  x.ts'])
  })
})

describe('定位、路径', () => {
  it('包含文件的各级文件夹和模块', () => {
    expect(ancestorKeys('staged', 'apps/app/lib/x.dart', modules)).toEqual([
      'd|staged|apps',
      'd|staged|apps/app',
      'd|staged|apps/app/lib',
      'm|staged|apps/app',
    ])
  })
  it('文件夹的工作区路径从文件推出来', () => {
    expect(folderLocal({ ...f('apps/app/lib/x.dart'), local: 'app/lib/x.dart' }, 'apps/app/lib')).toBe('app/lib')
    expect(folderLocal({ ...f('apps/app/lib/x.dart'), local: 'x.dart' }, 'apps/app/lib')).toBeNull()
    expect(folderLocal({ ...f('a/x'), local: null }, 'a')).toBeNull()
  })
})
