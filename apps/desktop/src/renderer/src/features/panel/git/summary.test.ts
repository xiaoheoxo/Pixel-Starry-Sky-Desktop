import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatus } from '../../../../../shared/types/project-tools'

// 演示数据和 ref 键这里用不到真的：顶替掉，只测读取状态的合并 / 重读
vi.mock('@/data', () => ({ isDemo: false }))
vi.mock('@/data/demo', () => ({ demo: () => ({ git: { status: {} } }) }))
vi.mock('@/features/editor/target', () => ({
  refKey: (r: object) => JSON.stringify(r),
  keyRef: (k: string) => JSON.parse(k),
}))

const status = (branch: string): GitStatus => ({ repo: true, branch }) as GitStatus
const ref = { projectId: 'p' }

let pending: ((s: GitStatus) => void)[]
let calls: number
beforeEach(() => {
  pending = []
  calls = 0
  vi.stubGlobal('window', {
    pixelsky: {
      projectTools: {
        gitStatus: () => {
          calls++
          return new Promise<GitStatus>(resolve => pending.push(resolve))
        },
      },
    },
  })
})
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('Git 状态读取（summary）', () => {
  it('正在读时，soft 刷新共用这一轮；普通刷新在这一轮后再读一次', async () => {
    const { refreshGitStatus } = await import('./summary')
    const first = refreshGitStatus({ projectId: 'a' }, true)
    const soft = refreshGitStatus({ projectId: 'a' }, true)
    expect(calls).toBe(1)
    const again = refreshGitStatus({ projectId: 'a' })
    pending[0]!(status('main'))
    await tick()
    // 第二轮：普通刷新要求的重读
    expect(calls).toBe(2)
    pending[1]!(status('dev'))
    await Promise.all([first, soft, again])
    expect(calls).toBe(2)
  })

  it('不同工作区互不合并；读完后可以再读', async () => {
    const { refreshGitStatus } = await import('./summary')
    const a = refreshGitStatus(ref)
    const b = refreshGitStatus({ projectId: 'q' })
    expect(calls).toBe(2)
    pending.forEach(resolve => resolve(status('main')))
    await Promise.all([a, b])
    const c = refreshGitStatus(ref)
    expect(calls).toBe(3)
    pending[2]!(status('main'))
    await c
  })

  it('读取失败不抛出，也不挡住下一次', async () => {
    const { refreshGitStatus } = await import('./summary')
    vi.stubGlobal('window', {
      pixelsky: { projectTools: { gitStatus: () => Promise.reject(new Error('不是 Git 仓库')) } },
    })
    await expect(refreshGitStatus({ projectId: 'x' })).resolves.toBeUndefined()
    await expect(refreshGitStatus({ projectId: 'x' })).resolves.toBeUndefined()
  })
})
