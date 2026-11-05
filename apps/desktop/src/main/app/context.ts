import type { EngineHost } from '@pixelsky/engine'
import type { HostEvent } from '@pixelsky/protocol'
import type { ProjectTools } from '../core/project-tools/tools'
import type { ExtensionPacks } from '../extension-packs/service'
import type { Machines } from '../machines/service'
import type { ProviderStore } from '../core/providers/store'
import type { ChannelToolsServer } from '../channels/channel-mcp'
import type { Channels } from '../core/channels/service'
import { EventBus } from './events'
import { Lifecycle } from './lifecycle'

/**
 * 主进程各模块共用的状态，由 index.ts 创建后按初始化顺序传下去（取代原来模块之间的 `export let` 接线）。
 * 后三项在对应模块初始化之后才有值；初始化之前收到的调用按原来的方式处理（多数报「项目尚未加载」或走本机）。
 */
export interface AppContext {
  readonly events: EventBus
  readonly lifecycle: Lifecycle
  /** 本机引擎宿主的事件，主进程里想跟着会话状态变的模块订阅（托盘，app/tray.ts） */
  readonly hostListeners: Set<(event: HostEvent) => void>
  /** 本机引擎宿主（engine/ipc.ts 的 initEngine） */
  engine: EngineHost | null
  /** SSH 机器（machines/service.ts 的 initMachines，在 initEngine 里） */
  machines: Machines | null
  /** 项目工具（workspace/project-tools-ipc.ts 的 initProjectTools） */
  projectTools: ProjectTools | null
  /** 自定义 API 的接口配置（providers/providers.ts 的 initProviders，在 initEngine 里） */
  providers: ProviderStore | null
  /** 扩展包（extension-packs/ipc.ts 的 initExtensionPacks；和 extensions/ 的 MCP / 插件是两回事） */
  extPacks: ExtensionPacks | null
  /** 把事项交给频道成员（channels/ipc.ts 的 initChannels）：定时任务交给频道成员时用（docs/ui/board-schedule.md） */
  dispatchIssue: ((channelId: string, issue: unknown) => Promise<{ taskId: string }>) | null
  /** 频道工具 MCP 和成员的扩展设置（channels/ipc.ts 的 initChannels；docs/ui/channels-collab-v2.md §1、§5） */
  channelTools: ChannelToolsServer | null
  /** 协作频道服务（channels/ipc.ts 的 initChannels）：消息通道发进频道、跟进卡片时用；比 initIm 晚就绪 */
  channels: Channels | null
  /**
   * 不经过窗口调用引擎操作表（engine/ipc.ts 的 initEngine）：和窗口的调用走同一层路由（含 SSH 机器），
   * owner 是搜索 / 产物扫描的分桶。手机端（main/mobile/）用它
   */
  engineCall: EngineCall | null
  /**
   * 文件、项目工具操作表（workspace/files-ipc.ts、project-tools-ipc.ts 注册）：通道名 → 不经过窗口的调用，
   * 路由和窗口一样由调用方经 ctx.machines 处理。手机的 Git / 文件 / 任务工具用它（docs/mobile-remote.md §18.4）
   */
  readonly toolOps: Map<string, (args: unknown[]) => unknown>
}

export type EngineCall = (channel: string, args: unknown[], owner: string) => Promise<unknown>

export function createAppContext(): AppContext {
  return {
    events: new EventBus(),
    lifecycle: new Lifecycle(),
    hostListeners: new Set(),
    engine: null,
    machines: null,
    projectTools: null,
    providers: null,
    extPacks: null,
    dispatchIssue: null,
    channelTools: null,
    channels: null,
    engineCall: null,
    toolOps: new Map(),
  }
}

/** 当前选中的机器（'local' 或 SSH 机器 ID） */
export function selectedMachine(ctx: AppContext): string {
  return ctx.machines?.currentId ?? 'local'
}
