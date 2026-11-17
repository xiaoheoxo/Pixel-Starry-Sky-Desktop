import { afterEach, describe, expect, it } from 'vitest'
import { setCurrentLocale } from '../../../i18n/core'
import type { GitFileChange, GitStatus } from '../../../../../shared/types/project-tools'
import {
  ago,
  diffEditable,
  diffMode,
  gitAbsolutePath,
  gitSections,
  needsCommitAll,
  neighbour,
  sameGitDiff,
  SECTION_PAGE,
  sectionPage,
  splitPath,
  syncState,
} from './gitModel'

afterEach(() => setCurrentLocale('zh-CN'))
const f = (path: string, code: GitFileChange['code'] = 'M'): GitFileChange => ({
  path,
  origPath: null,
  code,
  local: path,
  submodule: false,
})
const status = (patch: Partial<GitStatus>): GitStatus => ({
  repo: true,
  missing: false,
  root: 'r',
  branch: 'main',
  detached: false,
  head: 'h',
  initial: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  remotes: [],
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  truncated: false,
  operation: null,
  fetchedAt: null,
  busySessions: 0,
  ...patch,
})

describe('Git 面板显示规则', () => {
  it('分组顺序：冲突 → 暂存 → 更改 → 未跟踪，空组不显示；在分组之间切换文件', () => {
    const s = status({ conflicted: [f('c', 'U')], staged: [f('a')], untracked: [f('n', '?')] })
    const sections = gitSections(s)
    expect(sections.map(x => x.area)).toEqual(['conflicted', 'staged', 'untracked'])
    expect(neighbour(sections, 'staged', 'a', 1)?.file.path).toBe('n')
    expect(neighbour(sections, 'staged', 'a', -1)?.area).toBe('conflicted')
    expect(neighbour(sections, 'untracked', 'n', 1)).toBeNull()
  })
  it('没有暂存但有改动时提交全部', () => {
    expect(needsCommitAll(status({ unstaged: [f('a')] }))).toBe(true)
    expect(needsCommitAll(status({ staged: [f('a')], unstaged: [f('b')] }))).toBe(false)
    expect(needsCommitAll(status({}))).toBe(false)
  })
  it('面板窄于 560px 时只能行内显示', () => {
    expect(diffMode('split', 800)).toBe('split')
    expect(diffMode('split', 400)).toBe('inline')
    expect(diffMode('inline', 800)).toBe('inline')
  })
  it('路径拆分与「多久之前」', () => {
    expect(gitAbsolutePath('E:\\中文 项目\\', 'textures/a.png')).toBe('E:\\中文 项目\\textures\\a.png')
    expect(gitAbsolutePath('/home/project/', 'textures/a.png')).toBe('/home/project/textures/a.png')
    expect(gitAbsolutePath('/', 'a.png')).toBe('/a.png')
    expect(splitPath('src/a/b.ts')).toEqual({ name: 'b.ts', dir: 'src/a' })
    expect(splitPath('b.ts')).toEqual({ name: 'b.ts', dir: '' })
    const now = 10_000_000
    expect(ago(now - 10_000, now)).toBe('刚刚')
    expect(ago(now - 6 * 60_000, now)).toBe('6 分钟前')
    setCurrentLocale('en-US')
    expect(ago(now - 2 * 3600_000, now)).toBe('2 h ago')
  })
})

describe('输入框上方的拉取 / 推送（composer-git）', () => {
  it('没有远端或都同步了不显示；领先、落后、没推送过的分支显示', () => {
    expect(syncState(status({ ahead: 2 }))).toBeNull()
    const remote = { remotes: ['origin'], upstream: 'origin/main' }
    expect(syncState(status(remote))).toBeNull()
    expect(syncState(status({ ...remote, ahead: 2, behind: 1 }))).toEqual({ ahead: 2, behind: 1, unpublished: false })
    expect(syncState(status({ remotes: ['origin'] }))).toEqual({ ahead: 0, behind: 0, unpublished: true })
    expect(syncState(status({ remotes: ['origin'], detached: true, branch: null }))).toBeNull()
    expect(syncState(status({ remotes: ['origin'], initial: true }))).toBeNull()
  })
})

describe('sameGitDiff', () => {
  const d = { path: 'staged.js', original: 'a', modified: 'OLD', binary: false, tooLarge: false }
  it('内容一样才算同一份（状态刷新后重读：一样就不替换）', () => {
    expect(sameGitDiff(d, { ...d })).toBe(true)
    expect(sameGitDiff(d, { ...d, modified: 'NEW' })).toBe(false)
    expect(sameGitDiff(d, { ...d, original: null })).toBe(false)
    expect(sameGitDiff(d, { ...d, tooLarge: true })).toBe(false)
  })
  it('图片字节变化时刷新预览；新增和删除也算变化', () => {
    const image = { dataUrl: 'data:image/png;base64,OLD', bytes: 3 }
    const before = { ...d, original: null, modified: null, binary: true, images: { original: image, modified: image } }
    expect(sameGitDiff(before, structuredClone(before))).toBe(true)
    expect(
      sameGitDiff(before, { ...before, images: { original: image, modified: { ...image, dataUrl: 'NEW' } } }),
    ).toBe(false)
    expect(sameGitDiff(before, { ...before, images: { original: image, modified: null } })).toBe(false)
    expect(sameGitDiff(before, { ...before, images: undefined })).toBe(false)
    const lfs = { ...before, images: { original: { unavailable: 'lfs' as const }, modified: image } }
    expect(sameGitDiff(lfs, structuredClone(lfs))).toBe(true)
    expect(sameGitDiff(lfs, before)).toBe(false)
    expect(sameGitDiff(lfs, { ...lfs, images: { original: { unavailable: 'notImage' }, modified: image } })).toBe(false)
  })
})

describe('sectionPage', () => {
  const files = Array.from({ length: 2110 }, (_, i) => i)
  it('不超过一页全画，超过只画一页并给出剩下的个数', () => {
    expect(sectionPage(files.slice(0, SECTION_PAGE))).toEqual({ visible: files.slice(0, SECTION_PAGE), rest: 0 })
    const first = sectionPage(files)
    expect(first.visible).toHaveLength(SECTION_PAGE)
    expect(first.rest).toBe(2110 - SECTION_PAGE)
  })
  it('点「再显示」后上限加一页，到底时 rest 为 0', () => {
    expect(sectionPage(files, SECTION_PAGE * 2).visible).toHaveLength(SECTION_PAGE * 2)
    expect(sectionPage(files, 2200)).toMatchObject({ rest: 0 })
    expect(sectionPage(files, 2200).visible).toHaveLength(2110)
  })
})

describe('diffEditable', () => {
  const file = { local: 'src/a.ts', code: 'M', submodule: false } as const
  it('新版本是磁盘文件的才能直接改：未暂存、未跟踪、冲突', () => {
    expect(diffEditable('unstaged', file)).toBe(true)
    expect(diffEditable('untracked', { ...file, code: '?' })).toBe(true)
    expect(diffEditable('conflicted', { ...file, code: 'U' })).toBe(true)
    expect(diffEditable('staged', file)).toBe(false)
    expect(diffEditable('commit', file)).toBe(false)
  })
  it('删掉的、子模块、没有工作区路径的不能改', () => {
    expect(diffEditable('unstaged', { ...file, code: 'D' })).toBe(false)
    expect(diffEditable('unstaged', { ...file, submodule: true })).toBe(false)
    expect(diffEditable('unstaged', { ...file, local: null })).toBe(false)
  })
})
