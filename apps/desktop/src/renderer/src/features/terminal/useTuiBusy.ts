import { useSyncExternalStore } from 'react'
import { subscribeTuiBusy, tuiBusy } from './tuiActivity'

/** 终端模式里正在干活的会话 id（docs/ui/tui-toggle.md §5.5）；变了会重新渲染 */
export const useTuiBusy = (): ReadonlySet<string> => useSyncExternalStore(subscribeTuiBusy, tuiBusy)
