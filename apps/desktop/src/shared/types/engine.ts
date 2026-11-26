// 引擎系统：主进程、预加载脚本、渲染进程共用的接口类型。规格见 docs/engines.md §5.1
import type { EngineId, SessionSettings, UsageFilter, UsageRangeId } from '@pixelsky/protocol'

export interface UsageQuery {
  range: UsageRangeId
  filter: UsageFilter
}
/** rememberChoices: false：临时改的（频道拟计划切计划模式再切回），不记成新会话的默认值 */
export type SessionPatch = Partial<SessionSettings> & { title?: string; engine?: EngineId; rememberChoices?: false }
