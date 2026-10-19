// 引擎系统在界面这边的入口（docs/engines.md §11）
export {
  addProject,
  isLive,
  useComposerController,
  useDemoSourceController,
  useEngineBoot,
  useSession,
  useSessionTitle,
  useSidebarData,
  useStatusBar,
  useViewing,
  type ComposerController,
  type QueueController,
  type SidebarData,
  type SourceBlocker,
  type SourceMenuController,
  type StatusBarController,
} from './hooks'
export {
  bridge,
  getEngineState,
  redetectEngines,
  removeProject,
  renameProject,
  setViewingSet,
  useEngineState,
} from './store'
export { recentSpansProjects } from './sidebarData'
export { useSidebarFreezeOn } from './sidebarFreeze'
export { OPEN_SESSION_EVENT, useOpenSessionRequests } from './openRequests'
export {
  SOURCE_ACTION_EVENT,
  requestSourceAction,
  requestSourceActionAfterOpen,
  takePendingSourceAction,
  type SourceAction,
} from './sourceActions'
export { demoAnswer, demoRetry, useDemoQueueController } from './demoQueue'
export {
  DEFAULT_EFFORT,
  EFFORT_LABEL,
  PERMISSION_HINTS,
  PERMISSION_INFO,
  SELF_MODELS,
  effortLabel,
  selfModelLabel,
  selfModelOptions,
  engineAccent,
  relativeTime,
  taskKindLabel,
  toChangedFiles,
} from './labels'
