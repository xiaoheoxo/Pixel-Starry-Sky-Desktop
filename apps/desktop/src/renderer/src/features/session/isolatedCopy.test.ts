// 新建页「独立副本」（docs/ui/desktop-parity.md §3.2）：什么时候能开、从哪儿开、建副本时的命名
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {}
})
const projects = [
  { id: 'p', name: 'P', path: 'D:\\Work\\p', addedAt: 0 },
  { id: 'sub', name: 'Sub', path: 'D:/Work/repo/sub', addedAt: 0 },
]
vi.mock('@/features/engine/store', () => ({
  getEngineState: () => ({ projects }),
  useEngineState: () => projects,
}))
vi.mock('@/features/panel/git/summary', () => ({ cachedGitStatus: () => null, useGitStatus: () => null }))
import { bindDraftWorkspace } from '@/features/machines/drafts'
import type { GitStatus, ProjectCopy } from '../../../../shared/types/project-tools'
import { copyBase, createIsolatedCopy, isolatedOn, isolatedPlan, setIsolated } from './isolatedCopy'
import { copyName, defaultBranch } from './branch/naming'

const git = (patch: Partial<GitStatus> = {}): GitStatus =>
  ({
    repo: true,
    missing: false,
    root: 'D:/Work/p',
    branch: 'feat/x',
    detached: false,
    head: 'abc123',
    initial: false,
    ...patch,
  }) as GitStatus

describe('能不能开副本', () => {
  it('项目目录就是仓库根（斜杠、大小写、结尾分隔符不算不同）：从当前分支开', () => {
    expect(copyBase(git(), 'D:\\Work\\p\\')).toBe('feat/x')
    expect(copyBase(git(), 'd:/work/P')).toBe('feat/x')
  })
  it('分离 HEAD 从当前提交开', () => {
    expect(copyBase(git({ detached: true, branch: null }), 'D:/Work/p')).toBe('abc123')
  })
  it('不是仓库、没有提交、没装 git、子文件夹项目、还没读到状态：不能开', () => {
    expect(copyBase(git({ repo: false }), 'D:/Work/p')).toBeNull()
    expect(copyBase(git({ initial: true, head: null }), 'D:/Work/p')).toBeNull()
    expect(copyBase(git({ missing: true }), 'D:/Work/p')).toBeNull()
    expect(copyBase(git({ root: 'D:/Work/repo' }), 'D:/Work/repo/sub')).toBeNull()
    expect(copyBase(null, 'D:/Work/p')).toBeNull()
  })
  it('Linux 路径区分大小写', () => {
    expect(copyBase(git({ root: '/home/a/P' }), '/home/a/p')).toBeNull()
  })
  it('标签：选了副本、沿用了别的会话的目录、「对话」、子文件夹项目都不显示', () => {
    const status = (id: string) => (id === 'p' ? git() : git({ root: 'D:/Work/repo' }))
    expect(isolatedPlan('new:1', 'p', status)).toEqual({ projectId: 'p', base: 'feat/x' })
    expect(isolatedPlan('new:1', 'sub', status)).toBeNull()
    expect(isolatedPlan('new:1', 'chat', status)).toBeNull()
    expect(isolatedPlan('new:1', null, status)).toBeNull()
    bindDraftWorkspace('new:2', { projectId: 'p', name: 'P', path: 'x', copyId: 'c1', branch: null, error: null })
    expect(isolatedPlan('new:2', 'p', status)).toBeNull()
    bindDraftWorkspace('new:3', {
      projectId: 'p',
      name: 'P',
      path: 'x',
      copyId: null,
      branch: null,
      error: null,
      sessionId: 's',
    })
    expect(isolatedPlan('new:3', 'p', status)).toBeNull()
    // Ctrl+N / 窗格「+」从会话里新建：沿用的目录就是项目目录时照样能开（回归）
    bindDraftWorkspace('new:4', {
      projectId: 'p',
      name: 'P',
      path: 'd:/work/p/',
      copyId: null,
      branch: null,
      error: null,
      sessionId: 's',
    })
    expect(isolatedPlan('new:4', 'p', status)).toEqual({ projectId: 'p', base: 'feat/x' })
  })
  it('按项目记住开没开，默认关', () => {
    expect(isolatedOn('p')).toBe(false)
    setIsolated('p', true)
    expect(isolatedOn('p')).toBe(true)
    expect(isolatedOn('sub')).toBe(false)
    setIsolated('p', false)
    expect(isolatedOn('p')).toBe(false)
  })
})

describe('建副本', () => {
  it('分支名取第一条消息里的英文词，重名加序号；副本名取最后一段，避开已有的副本', async () => {
    const calls: unknown[] = []
    const api = {
      branches: async () => ['main', 'pixelsky/fix-login'],
      copyNames: async () => ['fix-login'],
      createCopy: async (projectId: string, input: unknown) => {
        calls.push([projectId, input])
        return { id: 'c' } as ProjectCopy
      },
    }
    await createIsolatedCopy(api, 'new:1', 'p', 'feat/x', 'Fix login 按钮')
    expect(calls).toEqual([
      ['p', { name: 'fix-login-2', branch: 'pixelsky/fix-login-2', existingBranch: false, base: 'feat/x' }],
    ])
  })
  it('没有英文词用日期时间', () => {
    expect(defaultBranch('修一下', [], new Date(2026, 10, 17, 9, 5))).toBe('pixelsky/branch-1117-0905')
    expect(copyName('pixelsky/branch-1117-0905', [])).toBe('branch-1117-0905')
  })
  it('回归：同一个项目两条一起发，第二条等第一条建好再起名，不撞分支名', async () => {
    const branches = ['main']
    const created: string[] = []
    const api = {
      branches: async () => [...branches],
      copyNames: async () => [],
      createCopy: async (_p: string, input: { branch: string }) => {
        await new Promise(r => setTimeout(r, 20))
        if (branches.includes(input.branch)) throw new Error('分支已经存在')
        branches.push(input.branch)
        created.push(input.branch)
        return { id: input.branch } as ProjectCopy
      },
    }
    await Promise.all([
      createIsolatedCopy(api, 'new:a', 'p', 'main', '修一下'),
      createIsolatedCopy(api, 'new:b', 'p', 'main', '改样式'),
    ])
    expect(created).toHaveLength(2)
    expect(created[1]).toBe(created[0] + '-2')
  })
  it('失败时错误带上「建独立副本失败」，下一次照常建', async () => {
    const api = {
      branches: async () => [],
      copyNames: async () => [],
      createCopy: async () => {
        throw new Error("Error invoking remote method 'projectTools:createCopy': Error: 目标目录已经存在")
      },
    }
    await expect(createIsolatedCopy(api, 'new:c', 'p', 'main', 'x')).rejects.toThrow('建独立副本失败：目标目录已经存在')
    const ok = { ...api, createCopy: async () => ({ id: 'ok' }) as ProjectCopy }
    await expect(createIsolatedCopy(ok, 'new:c', 'p', 'main', 'x')).resolves.toEqual({ id: 'ok' })
  })
  it('Windows 设备名（con、aux、nul、com1……）不拿来当分支名', () => {
    const now = new Date(2026, 10, 17, 9, 5)
    expect(defaultBranch('看下 con 的配置', [], now)).toBe('pixelsky/branch-1117-0905')
    expect(defaultBranch('AUX', [], now)).toBe('pixelsky/branch-1117-0905')
    expect(defaultBranch('com1 port', [], now)).toBe('pixelsky/com1-port')
  })
  it('截到 30 个字符时不留结尾的横线', () => {
    expect(defaultBranch('aaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbb', [])).toBe('pixelsky/aaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })
})
