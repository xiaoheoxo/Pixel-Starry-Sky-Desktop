// Claude Code 新版的任务工具（TaskCreate / TaskUpdate）→ 一份完整的待办清单。
// 旧的 TodoWrite 每次发整份清单；新工具每次只建一条或改一条，编号要等 TaskCreate 的结果才知道。
// 做法照 Claude Code 自己的：新建的先按 tool_use.id 记成「待定」，拿到结果里的编号再落定；改状态在调用时就生效。
import type { TodoStep } from '@pixelsky/protocol'
import { str } from './shape'

export const TASK_CREATE = 'TaskCreate'
export const TASK_UPDATE = 'TaskUpdate'

type Input = Record<string, unknown>
interface Task {
  text: string
  status: TodoStep['status']
  /** 上一轮没做完的（docs/ui/progress-card.md §11） */
  carried?: boolean
}

const STATUSES = new Set(['pending', 'in_progress', 'completed'])

export class TaskBoard {
  /** 已有编号的任务，按建的先后 */
  private tasks = new Map<string, Task>()
  /** 还没拿到编号的新建：key = tool_use.id */
  private pending = new Map<string, Task>()
  /** 用户发了新一轮，这一轮还没动过任务 */
  private fresh = false

  /** 用户发了新的一轮（断线重连自动发的「继续」不算） */
  newRound(): void {
    this.fresh = true
  }

  /**
   * 新一轮第一个任务调用是新建：这是一份新清单，之前做完的清掉，没做完的留一轮、不算进度。
   * 第一个调用是改状态：接着做原来的清单（说「继续」），什么都不动
   */
  private startList(): void {
    this.fresh = false
    // 上一轮建了没等到结果的（进程断了）：不会再有结果，留着就一直挂在清单里
    this.pending.clear()
    for (const [id, task] of this.tasks)
      if (task.status === 'completed' || task.carried) this.tasks.delete(id)
      else task.carried = true
  }

  /** 处理一次 TaskCreate / TaskUpdate 调用，返回调用之后的整份清单；别的工具返回 null */
  apply(toolUseId: string, name: string, input: Input): TodoStep[] | null {
    if (name === TASK_CREATE) {
      const text = str(input.subject) || str(input.activeForm)
      if (text) {
        if (this.fresh) this.startList()
        this.pending.set(toolUseId, { text, status: 'pending' })
      }
      return this.steps()
    }
    if (name !== TASK_UPDATE) return null
    // 删任务是在清旧的，不代表接着做原来的清单
    if (input.status !== 'deleted') this.fresh = false
    const id = str(input.taskId)
    if (input.status === 'deleted') this.tasks.delete(id)
    else {
      const old = this.tasks.get(id)
      const text = str(input.subject) || old?.text
      // 不认识的编号（进程重启前建的）又没给名字：不凭空加一条只写着编号的
      if (text) {
        const status = STATUSES.has(str(input.status))
          ? (str(input.status) as Task['status'])
          : (old?.status ?? 'pending')
        this.tasks.set(id, { text, status })
      }
    }
    return this.steps()
  }

  /** TaskCreate 的结果：编号在 tool_use_result.task.id，没有就从「Task #3 created」里取；失败就丢掉 */
  resolve(toolUseId: string, content: unknown, isError: boolean, toolUseResult: unknown): void {
    const task = this.pending.get(toolUseId)
    if (!task) return
    this.pending.delete(toolUseId)
    if (isError) return
    const result = toolUseResult && typeof toolUseResult === 'object' ? (toolUseResult as Input) : {}
    const fromResult = result.task && typeof result.task === 'object' ? str((result.task as Input).id) : ''
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    const id = fromResult || /Task #(\w+)/.exec(text)?.[1]
    if (id) this.tasks.set(id, task)
  }

  /** 现在的整份清单（不含上一轮没做完的） */
  steps(): TodoStep[] {
    return [...this.tasks.values(), ...this.pending.values()]
      .filter(t => !t.carried)
      .map(t => ({ text: t.text, status: t.status }))
  }

  /** 上一轮没做完的 */
  carried(): TodoStep[] {
    return [...this.tasks.values()].filter(t => t.carried).map(t => ({ text: t.text, status: t.status }))
  }
}
