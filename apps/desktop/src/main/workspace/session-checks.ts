// 会话的「做完自动检查」（docs/ui/channels-collab-v2.md §8）：输入框菜单里打开后，每一轮正常结束就在会话的工作目录跑一次产出检查，
// 结果推给窗口（checks:session），输入框上方显示一行。频道派活的会话由频道自己检查（写在任务卡上），这里不重复跑。
// 检查走项目工具的操作表，和窗口一样按会话路由到所在的机器
import { randomUUID } from 'node:crypto'
import type { HostEvent } from '@pixelsky/protocol'
import { describeError, logger } from '@pixelsky/engine'
import type { AppContext } from '../app/context'
import * as ipc from '../ipc/guard'
import { machineOf } from '../machines/identity'
import { pageCheckUrl, type CheckPlan, type CheckRun } from '../../shared/types/checks'
import { probePage } from './page-check'

const KEEP = 200

export function initSessionChecks(ctx: AppContext): void {
  const log = logger('checks')
  /** 会话 → 最近一次检查（窗口打开会话时取） */
  const last = new Map<string, CheckRun>()
  const call = async (channel: string, args: unknown[]): Promise<unknown> => {
    const op = ctx.toolOps.get(channel)
    if (!op) throw new Error('项目尚未加载')
    return ctx.machines ? ctx.machines.invoke(channel, args, () => op(args)) : op(args)
  }
  const publish = (sessionId: string, run: CheckRun | null): void => {
    if (run) {
      last.delete(sessionId)
      last.set(sessionId, run)
      if (last.size > KEEP) last.delete(last.keys().next().value!)
    } else last.delete(sessionId)
    ctx.events.broadcast('checks:session', { sessionId, run })
  }
  /** 这个会话要打开的页面：要在这台电脑上跑（远程机器的 localhost 不是这里的），项目设置里填了地址 */
  const pageOf = async (sessionId: string): Promise<string | null> => {
    if (machineOf(sessionId) !== 'local') return null
    const plan = (await call('projectTools:checkPlan', [{ sessionId }]).catch(() => null)) as CheckPlan | null
    return plan ? pageCheckUrl(plan.config.page) : null
  }
  const check = async (sessionId: string): Promise<void> => {
    if (ctx.channelTools?.ownsSession(sessionId)) return
    if (!(await call('projectTools:sessionChecks', [{ sessionId }]).catch(() => false))) return
    const pending: CheckRun = { id: `pending-${Date.now()}`, at: Date.now(), status: 'running', items: [] }
    publish(sessionId, pending)
    try {
      let run = (await call('projectTools:runChecks', [{ sessionId }, { when: 'session' }])) as CheckRun | null
      const page = await pageOf(sessionId)
      // 跑命令期间开始了新的一轮：不用再开页面
      if (page && last.get(sessionId)?.id === pending.id) {
        const result = await probePage(page)
        run = {
          ...(run ?? { id: randomUUID(), at: Date.now(), items: [] }),
          status: 'done',
          items: [...(run?.items ?? []), result],
          endedAt: Date.now(),
        }
      }
      if (last.get(sessionId)?.id === pending.id) publish(sessionId, run)
    } catch (error) {
      log.warn('会话的产出检查失败', { error: describeError(error) })
      if (last.get(sessionId)?.id === pending.id) publish(sessionId, null)
    }
  }
  ctx.events.taps.add((channel, args) => {
    if (channel !== 'engine:event') return
    const event = args[0] as HostEvent
    if (event.kind !== 'session') return
    // 新的一轮开始了：上一轮的结果不再是「这一轮」的
    if (event.event.type === 'turn_started' && last.has(event.sessionId)) publish(event.sessionId, null)
    if (event.event.type === 'turn_completed' && event.event.outcome === 'completed') void check(event.sessionId)
  })
  ipc.handle('checks:last', (_e, sessionId) => (typeof sessionId === 'string' ? (last.get(sessionId) ?? null) : null))
}
