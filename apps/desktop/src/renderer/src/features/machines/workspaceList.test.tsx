// issue #11：工作区列表缓存，以及已经开始的会话里输入框上方只显示工作区
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// 引擎和机器的 store 在导入时读 window.pixelsky：先放一个空的 window
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {}
})
// 机器列表用 useSyncExternalStore，服务端渲染没有快照：换成静态的
vi.mock('@/features/machines/store', () => ({
  useMachines: () => ({ machines: [{ id: 'local', name: '本机' }], currentId: 'local' }),
  openMachineManager: () => {},
  openWorkspacePicker: () => {},
}))
// 输入框上方的 Git 那几项（docs/ui/composer-git.md）不在这里测：它导入的账号模块要真的 window
vi.mock('@/features/session/ComposerGit', () => ({ ComposerGit: () => null }))
// 「独立副本」开关要读 Git 状态和引擎 store（服务端渲染没有快照），在 isolatedCopy.test.ts 里测
vi.mock('@/features/session/isolatedCopy', () => ({ useIsolatedCopy: () => null }))
// 已开始会话的文件夹菜单（docs/ui/machines-workspaces.md §9）同理换成只带参数的壳，这里只看给它的名字和路径
vi.mock('@/features/session/FolderMenu', () => ({
  FolderMenu: ({ name, path }: { name: string; path: string }) => (
    <span data-composer-project data-folder-menu title={path}>
      {name}
    </span>
  ),
}))
vi.mock('@/features/editor/target', () => ({ useActiveWorkspace: () => ({ name: '', path: '', ref: null, key: '' }) }))
import { I18nProvider } from '@/i18n/I18nProvider'
import type { StatusBarController } from '@/features/engine'
import type { WorkspaceChoice } from '../../../../shared/types/machines'
import { ComposerStatusBar } from '@/features/session/ComposerStatusBar'
import { cachedWorkspaces, clearWorkspaceCache, loadWorkspaces } from './workspaceList'

const projects = [
  { id: 'a', name: 'A', path: 'D:/a' },
  { id: 'b', name: 'B', path: 'D:/b' },
]
const row = (projectId: string, extra: Partial<WorkspaceChoice> = {}): WorkspaceChoice => ({
  projectId,
  name: projectId.toUpperCase(),
  path: 'D:/' + projectId,
  copyId: null,
  branch: 'main',
  error: null,
  ...extra,
})

let calls: string[] = []
let fail = new Set<string>()
let gate: Promise<void> = Promise.resolve()
beforeEach(() => {
  calls = []
  fail = new Set()
  gate = Promise.resolve()
  clearWorkspaceCache()
  ;(globalThis as { window?: unknown }).window = {
    pixelsky: {
      machines: {
        workspaces: async (id: string) => {
          calls.push(id)
          await gate
          if (fail.has(id)) throw new Error('读不到')
          return id === 'a' ? [row('a'), row('a', { copyId: 'c1', name: 'copy', path: 'D:/a-copy' })] : [row(id)]
        },
      },
    },
  }
})
afterEach(() => {
  ;(globalThis as { window?: unknown }).window = {}
})

describe('工作区列表缓存', () => {
  it('没读过时为空；读过后按项目顺序给出，新加的项目先只列项目本身，删掉的项目不再出现', async () => {
    expect(cachedWorkspaces('local', projects)).toBeNull()
    await loadWorkspaces('local', projects, e => (e as Error).message)
    expect(cachedWorkspaces('local', projects)?.map(w => w.copyId ?? w.projectId)).toEqual(['a', 'c1', 'b'])
    const later = cachedWorkspaces('local', [projects[1], { id: 'n', name: 'New', path: 'D:/n' }, projects[0]])
    expect(later?.map(w => [w.projectId, w.copyId, w.branch])).toEqual([
      ['b', null, 'main'],
      ['n', null, null],
      ['a', null, 'main'],
      ['a', 'c1', 'main'],
    ])
    expect(cachedWorkspaces('local', [projects[1]])?.map(w => w.projectId)).toEqual(['b'])
    // 按机器分开
    expect(cachedWorkspaces('ssh-1', projects)).toBeNull()
  })

  it('同一组项目正在读时不重复读；读不到的项目给一行带错误的', async () => {
    let open = () => {}
    gate = new Promise(r => (open = r))
    fail.add('b')
    const first = loadWorkspaces('local', projects, e => (e as Error).message)
    const second = loadWorkspaces('local', projects, e => (e as Error).message)
    expect(second).toBe(first)
    open()
    const rows = await first
    expect(calls).toEqual(['a', 'b'])
    expect(rows.find(w => w.projectId === 'b')).toMatchObject({ error: '读不到', path: 'D:/b', branch: null })
    // 读完可以再读（后台刷新）
    await loadWorkspaces('local', projects, e => (e as Error).message)
    expect(calls).toEqual(['a', 'b', 'a', 'b'])
  })
})

describe('输入框上方的工作区', () => {
  const status = (canPickProject: boolean): StatusBarController => ({
    project: { id: 'a', name: '我的项目', path: 'D:/a' },
    projects,
    canPickProject,
    selectProject: () => {},
    addProject: () => {},
  })
  const html = (canPickProject: boolean) =>
    renderToStaticMarkup(
      <I18nProvider>
        <ComposerStatusBar live={status(canPickProject)} />
      </I18nProvider>,
    )

  it('新会话：可以点开换工作区', () => {
    const out = html(true)
    expect(out).toContain('aria-label="切换工作区"')
    expect(out).toContain('我的项目')
  })

  it('已经开始的会话：不能换工作区，是文件夹菜单（悬停看路径）', () => {
    const out = html(false)
    expect(out).not.toContain('aria-label="切换工作区"')
    expect(out).toContain('data-folder-menu')
    expect(out).toContain('data-composer-project')
    expect(out).toContain('title="D:/a"')
    expect(out).toContain('我的项目')
  })
})
