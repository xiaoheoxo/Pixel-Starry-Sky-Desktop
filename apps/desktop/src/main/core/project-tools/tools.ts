// 项目工具的装配（docs/ui/project-tools.md）：任务、服务、Git 副本、Git 面板。本机和远端辅助进程用同一套接线
import type { EngineHost } from '@pixelsky/engine'
import type { SessionRecord } from '@pixelsky/protocol'
import type { AiPlan } from '../../../shared/types/project-tools'
import type { WorkspaceRef, WorkspaceTarget } from '../../../shared/types/workspace'
import { samePath, type ToolsHost } from './common'
import { Copies } from './copies'
import { GitTools, type GitTrash } from './git'
import { Services } from './services'
import { Tasks } from './tasks'

export class ProjectTools {
  readonly tasks: Tasks
  readonly services: Services
  readonly copies: Copies
  readonly git: GitTools

  constructor(
    dir: string,
    host: ToolsHost,
    changed: () => void,
    opts: { trash?: GitTrash; stopTerminals?: (path: string) => Promise<void> } = {},
  ) {
    this.tasks = new Tasks(dir, host, changed)
    // 服务和副本互相引用：删除副本前先停它目录里的服务，启动服务前核对副本
    this.services = new Services(dir, host, changed, (id, path) => this.copies.verifyPath(id, path))
    this.copies = new Copies(dir, host, changed, async path => {
      await opts.stopTerminals?.(path)
      await this.services.stopPath(path)
    })
    this.git = new GitTools(host, changed, { trash: opts.trash })
  }

  async init(): Promise<void> {
    await Promise.all([this.tasks.init(), this.copies.init()])
    await this.services.init()
  }

  shutdown(): Promise<void> {
    return this.services.shutdown()
  }

  /** 新会话绑定到副本：副本必须属于项目且仍是有效的 worktree */
  async copyPath(projectId: string, copyId: string): Promise<string> {
    const copy = this.copies.get(copyId)
    if (copy.projectId !== projectId) throw new Error('副本不属于项目')
    await this.copies.verify(copy)
    return copy.path
  }
}

/**
 * 项目工具看到的引擎：解析工作区、列 AI 计划和会话、在副本里新建会话。
 * `host` 是取值函数：本机的 EngineHost 在初始化引擎后才有。
 */
export function createToolsHost(opts: {
  host: () => EngineHost | null
  resolve: (ref: WorkspaceRef) => WorkspaceTarget
  record: (id: string) => SessionRecord | null | undefined
}): ToolsHost {
  const loaded = (): EngineHost => {
    const host = opts.host()
    if (!host) throw new Error('项目尚未加载')
    return host
  }
  // 同一个项目同时只读一次；读的过程中又来的请求合成一次接着读（任务面板在项目工具每次变化时都会重新取）
  const plansOf = coalesceBy<AiPlan[]>()
  return {
    resolve(ref) {
      const target = opts.resolve(ref)
      const projectId = ref.projectId ?? opts.record(ref.sessionId!)?.projectId
      if (!projectId) throw new Error('项目不存在')
      return { projectId, name: target.name, path: target.path }
    },
    plans(projectId) {
      const host = opts.host()
      if (!host) return Promise.resolve([])
      return plansOf(projectId, async () => {
        // 只取最后一个 todo：不能用 host.open（会为每个会话建运行时、整份读进来并一直留着）。
        // 一次只读几个会话的文件，冷启动时不会同时开上百个句柄、分配上百份读取缓冲
        const found = await mapLimit(
          host.sessions().filter(s => s.record.projectId === projectId && !s.record.archivedAt),
          PLAN_CONCURRENCY,
          async s => {
            const item = await host.lastTodo(s.record.id).catch(() => null)
            return item ? { sessionId: s.record.id, title: s.record.title, item } : null
          },
        )
        return found.flatMap(plan => (plan ? [plan] : []))
      })
    },
    sessions(path) {
      return (
        opts
          .host()
          ?.sessions()
          .filter(s => samePath(s.record.cwd, path))
          .map(s => ({ id: s.record.id, title: s.record.title, state: s.state })) ?? []
      )
    },
    create(projectId, cwd) {
      return loaded().createSession({ projectId }, cwd)
    },
    async withStopped(path, action) {
      return loaded().withWorkspaceStopped(path, action)
    },
  }
}

/** 一次读几个会话的 items.jsonl */
const PLAN_CONCURRENCY = 4

/** 按顺序取结果，同时最多跑 limit 个 */
async function mapLimit<T, R>(list: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length)
  let next = 0
  const worker = async () => {
    while (next < list.length) {
      const i = next++
      out[i] = await task(list[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker))
  return out
}

/**
 * 按 key 合并重叠的请求：同一个 key 正在跑时，新请求不并行再跑一份，而是排在后面、只再跑一次
 * （排队期间来的请求共用这一次）。排队的那次在前一次结束后才开始，所以拿到的一定是请求之后的数据
 */
function coalesceBy<T>(): (key: string, task: () => Promise<T>) => Promise<T> {
  interface Slot {
    running: Promise<T>
    queued: Promise<T> | null
  }
  const slots = new Map<string, Slot>()
  const start = (key: string, task: () => Promise<T>): Promise<T> => {
    const slot: Slot = {
      running: task().finally(() => {
        // 有人排队时，排队的那次接着跑；没有就清掉
        if (!slot.queued && slots.get(key) === slot) slots.delete(key)
      }),
      queued: null,
    }
    slots.set(key, slot)
    return slot.running
  }
  return (key, task) => {
    const slot = slots.get(key)
    if (!slot) return start(key, task)
    slot.queued ??= slot.running
      .catch(() => undefined)
      .then(() => {
        slot.queued = null
        return start(key, task)
      })
    return slot.queued
  }
}
