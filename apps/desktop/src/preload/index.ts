import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { HostEvent, IpcChannelName } from '@pixelsky/protocol'
import type { AccountState } from '../shared/types/account'
import type { AccountBridge } from './account'
import type { AppInfoBridge } from './app-info'
import type { UpdateBridge } from './update'
import type { UpdateState } from '../shared/types/update'
import type { EngineBridge } from './engine'
import type { FilesBridge, EditorBridge } from './workspace'
import type { WindowState } from '../shared/types/window'
import type { WindowBridge } from './window'
import type { ExtensionsBridge } from './extensions'
import type { ExtPacksBridge } from './extpacks'
import type { ExtStoreBridge } from './extstore'
import type { TerminalBridge } from './terminal'
import type { ProjectToolsBridge } from './project-tools'
import type { NotificationClick } from '../shared/types/notifications'
import type { NotificationsBridge } from './notifications'
import type { ArtifactsBridge } from './artifacts'
import type { LogBridge } from './log'
import type { TrayBridge } from './tray'
import type { MobileBridge } from './mobile'
import type { MobileState } from '../shared/types/mobile'
import type { SettingsSyncBridge } from './settings-sync'
import type { FeedbackBridge } from './feedback'
import type { FeedbackChange } from '../shared/types/feedback'
import type { TrayCommand } from '../shared/types/tray'
import type { ChannelsBridge } from './channels'
import type { ChannelMessagePush, ChannelsSnapshot } from '../shared/types/channels'

// 通道名一律用契约键约束：拼错或未登记的通道在这里就是类型错误
type Listener = Parameters<typeof ipcRenderer.on>[1]
const invoke = <T = unknown>(channel: IpcChannelName, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args)
const send = (channel: IpcChannelName, ...args: unknown[]): void => ipcRenderer.send(channel, ...args)
const sendSync = (channel: IpcChannelName, ...args: unknown[]): unknown => ipcRenderer.sendSync(channel, ...args)
const on = (channel: IpcChannelName, listener: Listener): void => {
  ipcRenderer.on(channel, listener)
}

// 启动配置由主进程同步提供（沙箱里的 preload 拿不到命令行参数）
const config = sendSync('app:config') as { demo: boolean }

// 账号登录与额度：所有网络请求都在主进程，这里只转发 IPC（规格见 docs/ui/account.md §4.2）
const account: AccountBridge = {
  listCalls: query => invoke('account:calls', query),
  summary: query => invoke('account:summary', query),
  getState: () => invoke('account:get'),
  login: () => invoke('account:login'),
  cancelLogin: () => invoke('account:cancel'),
  logout: () => invoke('account:logout'),
  refresh: () => invoke('account:refresh'),
  store: () => invoke('account:store'),
  openStore: (kind, params) => invoke('account:openStore', kind, params),
  onChange: cb => {
    const listener = (_event: Electron.IpcRendererEvent, s: AccountState): void => cb(s)
    on('account:changed', listener)
    return () => {
      ipcRenderer.removeListener('account:changed', listener)
    }
  },
}

/** invoke 抛出的错误带着「Error invoking remote method 'xxx': Error: 」前缀，去掉后只留给用户看的那句话 */
async function call<T>(channel: IpcChannelName, ...args: unknown[]): Promise<T> {
  try {
    return (await invoke(channel, ...args)) as T
  } catch (err) {
    const message = String((err as Error)?.message ?? err).replace(
      /^Error invoking remote method '[^']+': (\w*Error: )?/,
      '',
    )
    throw new Error(message)
  }
}

// 引擎系统：会话都在主进程里跑，这里只转发 IPC（规格见 docs/engines.md §5）
const engine: EngineBridge = {
  search: query => call('engine:search', query),
  cancelSearch: id => call('engine:cancelSearch', id),
  config: () => call('engine:config'),
  setConfig: (engine, patch) => call('engine:setConfig', engine, patch),
  setDefaultEngine: engine => call('engine:setDefaultEngine', engine),
  catalog: (engine, force) => call('engine:catalog', engine, force),
  updateEngine: engine => call('engine:update', engine),
  installEngine: engine => call('engine:install', engine),
  loginEngine: (engine, method) => call('engine:login', engine, method),
  loginInput: (engine, text) => call('engine:loginInput', engine, text),
  cancelLogin: engine => call('engine:loginCancel', engine),
  logoutEngine: engine => call('engine:logout', engine),
  retrySettings: () => call('engine:retrySettings'),
  setRetrySettings: maxRetries => call('engine:setRetrySettings', maxRetries),
  engines: force => call('engine:engines', !!force),
  defaults: () => call('engine:defaults'),
  projects: () => call('engine:projects'),
  addProject: () => call('engine:addProject'),
  addProjects: paths => call('engine:addProjects', paths),
  importCandidates: () => call('engine:importCandidates'),
  scanProjectImports: () => call('projectImport:scan'),
  pickProjectImports: kind => call('projectImport:choose', kind),
  previewProjectPaths: text => call('projectImport:paths', text),
  removeProject: id => call('engine:removeProject', id),
  renameProject: (id, name) => call('engine:renameProject', id, name),
  setProjectFolders: (id, folders) => call('engine:setProjectFolders', id, folders),
  pickFolders: () => call('engine:pickFolders'),
  sessions: () => call('engine:sessions'),
  createSession: opts => call('engine:createSession', opts),
  openSession: id => call('engine:openSession', id),
  openSessionTail: (id, opts) => call('engine:openSessionTail', id, opts),
  itemDetail: (id, itemId) => call('engine:itemDetail', id, itemId),
  send: (id, text) => call('engine:send', id, text),
  context: (id, detail) => call('engine:context', id, detail),
  compact: id => call('engine:compact', id),
  cancelQueued: (id, queueId) => call('engine:cancelQueued', id, queueId),
  dismissQueued: (id, queueId) => call('engine:dismissQueued', id, queueId),
  moveQueued: (id, queueId, to) => call('engine:moveQueued', id, queueId, to),
  runQueuedNow: (id, queueId) => call('engine:runQueuedNow', id, queueId),
  steerQueued: (id, queueId, turnId) => call('engine:steerQueued', id, queueId, turnId),
  resumeQueue: id => call('engine:resumeQueue', id),
  rewindPreview: (id, itemId) => call('engine:rewindPreview', id, itemId),
  rewind: (id, itemId, options) => call('engine:rewind', id, itemId, options),
  undoRewind: id => call('engine:undoRewind', id),
  fork: (id, itemId, title) => call('engine:fork', id, itemId, title),
  nativeSessions: (projectId, engine, opts) => call('engine:nativeSessions', projectId, engine, opts),
  nativeSessionDetails: (projectId, engine, ids) => call('engine:nativeSessionDetails', projectId, engine, ids),
  importNativeSession: (projectId, engine, nativeId, opts) =>
    call('engine:importNativeSession', projectId, engine, nativeId, opts),
  cancelNativeImport: token => call('engine:cancelNativeImport', token),
  nativeSessionAction: (id, kind) => call('engine:nativeSessionAction', id, kind),
  sideQuestion: (id, question, history) => call('engine:sideQuestion', id, question, history),
  cancelSideQuestion: id => call('engine:cancelSideQuestion', id),
  interrupt: (id, opts) => call('engine:interrupt', id, ...(opts ? [opts] : [])),
  interruptTurn: (id, turnId) => call('engine:interruptTurn', id, turnId),
  answer: (id, requestId, decision) => call('engine:answer', id, requestId, decision),
  updateSession: (id, patch) => call('engine:updateSession', id, patch),
  deleteSession: id => call('engine:deleteSession', id),
  archiveSession: (id, archived, stopRunning) => call('engine:archiveSession', id, archived, stopRunning),
  renameSession: (id, title) => call('engine:renameSession', id, title),
  setSessionBottom: (id, bottomed) => call('engine:setSessionBottom', id, bottomed),
  setSessionPinned: (id, pinned) => call('engine:setSessionPinned', id, pinned),
  stopTask: (id, taskId) => call('engine:stopTask', id, taskId),
  taskOutput: (id, taskId) => call('engine:taskOutput', id, taskId),
  subagentTranscript: (id, agentId) => call('engine:subagentTranscript', id, agentId),
  usageSummary: q => call('engine:usageSummary', q),
  usageList: q => call('engine:usageList', q),
  usageExport: q => call('engine:usageExport', q),
  usageClear: () => call('engine:usageClear'),
  onEvent: cb => {
    const listener = (_event: Electron.IpcRendererEvent, e: HostEvent): void => cb(e)
    on('engine:event', listener)
    return () => {
      ipcRenderer.removeListener('engine:event', listener)
    }
  },
}

// 「关于」页：版本、运行环境，打开数据目录等（docs/ui/settings.md §5）
const appInfo: AppInfoBridge = {
  getInfo: () => call('app:info'),
  open: link => call('app:open', link),
  whatsNew: () => call('app:whatsNew'),
  setWhatsNew: patch => call('app:whatsNewSet', patch),
  ready: () => call('app:ready'),
}

// 本机日志（docs/ui/logging.md §4.7）：实时条目只在有页面订阅时才让主进程推过来
const logListeners = new Set<(entry: import('@pixelsky/protocol').LogEntry) => void>()
const log: LogBridge = {
  read: query => call('log:read', query),
  onEntry: callback => {
    if (logListeners.size === 0) {
      on('log:entry', logEntryListener)
      void invoke('log:watch', true)
    }
    logListeners.add(callback)
    return () => {
      logListeners.delete(callback)
      if (logListeners.size > 0) return
      ipcRenderer.removeListener('log:entry', logEntryListener)
      void invoke('log:watch', false)
    }
  },
  settings: () => call('log:settings'),
  setVerbose: enabled => call('log:setVerbose', enabled),
  openFolder: () => call('log:open'),
  exportDiagnostics: () => call('log:export'),
  write: (level, message, fields) => send('log:write', { level, message, fields }),
  uncaught: () => send('log:uncaught'),
  sample: sample => call('log:sample', sample),
}
function logEntryListener(_e: Electron.IpcRendererEvent, entry: import('@pixelsky/protocol').LogEntry): void {
  for (const listener of logListeners) listener(entry)
}

// 自动更新（docs/release-update.md §7）
const update: UpdateBridge = {
  state: () => call('update:state'),
  check: () => call('update:check'),
  install: () => call('update:install'),
  download: () => call('update:download'),
  setBeta: beta => call('update:setBeta', beta),
  onChange: callback => {
    const listener = (_e: Electron.IpcRendererEvent, state: UpdateState): void => callback(state)
    on('update:changed', listener)
    return () => {
      ipcRenderer.removeListener('update:changed', listener)
    }
  },
}

// 渲染进程能用的能力只通过这里暴露，统一挂在 window.pixelsky 上
const files: FilesBridge = {
  target: ref => call('files:target', ref),
  list: (ref, path) => call('files:list', ref, path),
  listExisting: (ref, path) => call('files:list', ref, path, true),
  search: (ref, name) => call('files:search', ref, name),
  grep: (ref, query) => call('files:grep', ref, query),
  create: (ref, path, kind) => call('files:create', ref, path, kind),
  rename: (ref, from, to) => call('files:rename', ref, from, to),
  remove: (ref, path) => call('files:remove', ref, path),
  status: ref => call('files:status', ref),
  read: (ref, path) => call('files:read', ref, path),
  headContent: (ref, path) => call('files:headContent', ref, path),
  save: (ref, path, text, version) => call('files:save', ref, path, text, version),
  reveal: (ref, path) => call('files:reveal', ref, path),
  copyPath: (ref, path) => call('files:copyPath', ref, path),
  onBeforeClose: cb => {
    const listener = (): void => cb()
    on('files:beforeClose', listener)
    return () => ipcRenderer.removeListener('files:beforeClose', listener)
  },
  finishClose: () => call('files:finishClose'),
}
const editor: EditorBridge = {
  state: force => call('editor:state', force),
  preferences: patch => call('editor:preferences', patch),
  choose: (kind, name, mode) => call('editor:choose', kind, name, mode),
  remove: id => call('editor:remove', id),
  open: (ref, id, path, line, col) => call('editor:open', ref, id, path, line, col),
  openMemory: (sessionId, path, action) => call('editor:openMemory', sessionId, path, action),
  statOutside: path => call('editor:statOutside', path),
  revealOutside: path => call('editor:revealOutside', path),
}
const windowControls: WindowBridge = {
  getState: () => call('window:getState'),
  minimize: () => call('window:minimize'),
  toggleMaximize: () => call('window:toggleMaximize'),
  snap: (layout, zone) => call('window:snap', layout, zone),
  snapOptions: () => call('window:snapOptions'),
  restoreSnap: () => call('window:restoreSnap'),
  close: () => call('window:close'),
  onState: cb => {
    const listener = (_event: Electron.IpcRendererEvent, state: WindowState): void => cb(state)
    on('window:state', listener)
    return () => ipcRenderer.removeListener('window:state', listener)
  },
}
const projectTools: ProjectToolsBridge = {
  searchTasks: (text, id) => call('projectTools:searchTasks', text, id),
  pinTask: (id, pinned) => call('projectTools:pinTask', id, pinned),
  pinnedTasks: () => call('projectTools:pinnedTasks'),
  allTasks: () => call('projectTools:allTasks'),
  tasks: id => call('projectTools:tasks', id),
  createTask: (id, input) => call('projectTools:createTask', id, input),
  updateTask: (id, patch) => call('projectTools:updateTask', id, patch),
  deleteTask: id => call('projectTools:deleteTask', id),
  reorderTasks: (id, ids) => call('projectTools:reorderTasks', id, ids),
  environment: (ref, force) => call('projectTools:environment', ref, force),
  runTasks: (ref, templates) => call('projectTools:runTasks', ref, templates),
  gradleTasks: (ref, buildDir) => call('projectTools:gradleTasks', ref, buildDir),
  gradleTasksCancel: (ref, buildDir) => call('projectTools:gradleTasksCancel', ref, buildDir),
  services: ref => call('projectTools:services', ref),
  saveService: (ref, input) => call('projectTools:saveService', ref, input),
  deleteService: id => call('projectTools:deleteService', id),
  startService: id => call('projectTools:startService', id),
  stopService: (id, force) => call('projectTools:stopService', id, force),
  restartService: id => call('projectTools:restartService', id),
  portStatus: port => call('projectTools:portStatus', port),
  copies: id => call('projectTools:copies', id),
  branches: id => call('projectTools:branches', id),
  previewCopy: (id, input) => call('projectTools:previewCopy', id, input),
  createCopy: (id, input) => call('projectTools:createCopy', id, input),
  openCopy: id => call('projectTools:openCopy', id),
  removeCopy: (id, force) => call('projectTools:removeCopy', id, force),
  forgetCopy: id => call('projectTools:forgetCopy', id),
  chooseDirectory: () => call('projectTools:chooseDirectory'),
  openPath: ref => call('projectTools:openPath', ref),
  revealCopy: id => call('projectTools:revealCopy', id),
  openExternal: url => call('projectTools:openExternal', url),
  gitStatus: ref => call('projectTools:gitStatus', ref),
  gitDiff: (ref, input) => call('projectTools:gitDiff', ref, input),
  gitBranches: ref => call('projectTools:gitBranches', ref),
  gitStage: (ref, paths) => call('projectTools:gitStage', ref, paths),
  gitUnstage: (ref, paths) => call('projectTools:gitUnstage', ref, paths),
  gitDiscard: (ref, input) => call('projectTools:gitDiscard', ref, input),
  gitCommit: (ref, input) => call('projectTools:gitCommit', ref, input),
  gitCommitContext: (ref, input) => call('projectTools:gitCommitContext', ref, input),
  gitPull: (ref, mode) => call('projectTools:gitPull', ref, mode),
  gitPush: (ref, input) => call('projectTools:gitPush', ref, input),
  gitFetch: ref => call('projectTools:gitFetch', ref),
  gitSwitch: (ref, input) => call('projectTools:gitSwitch', ref, input),
  gitCreateBranch: (ref, input) => call('projectTools:gitCreateBranch', ref, input),
  gitOperation: (ref, action) => call('projectTools:gitOperation', ref, action),
  gitLog: (ref, query) => call('projectTools:gitLog', ref, query),
  gitRefs: ref => call('projectTools:gitRefs', ref),
  gitShow: (ref, hash) => call('projectTools:gitShow', ref, hash),
  gitCompare: (ref, kind) => call('projectTools:gitCompare', ref, kind),
  gitHistoryAction: (ref, action) => call('projectTools:gitHistoryAction', ref, action),
  onChange: cb => {
    const listener = (): void => cb()
    on('projectTools:changed', listener)
    return () => ipcRenderer.removeListener('projectTools:changed', listener)
  },
}
const projectBrowser: import('./project-browser').BrowserBridge = {
  state: ref => call('projectBrowser:state', ref),
  navigate: (ref, id, url) => call('projectBrowser:navigate', ref, id, url),
  select: (ref, id) => call('projectBrowser:select', ref, id),
  action: (ref, id, action) => call('projectBrowser:action', ref, id, action),
  viewport: (ref, bounds) => call('projectBrowser:viewport', ref, bounds),
  annotate: (ref, id, text) => call('projectBrowser:annotate', ref, id, text),
  removeAnnotation: (ref, id, annotationId) => call('projectBrowser:removeAnnotation', ref, id, annotationId),
  onChange: cb => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      state: import('../shared/types/project-browser').BrowserState,
    ): void => cb(state)
    on('projectBrowser:changed', listener)
    return () => ipcRenderer.removeListener('projectBrowser:changed', listener)
  },
}
const terminal: TerminalBridge = {
  state: force => call('terminal:state', force),
  setDefaultProfile: id => call('terminal:setDefaultProfile', id),
  saveProfile: profile => call('terminal:saveProfile', profile),
  removeProfile: id => call('terminal:removeProfile', id),
  resetProfiles: () => call('terminal:resetProfiles'),
  chooseProgram: () => call('terminal:chooseProgram'),
  create: (ref, profileId, requestId) => call('terminal:create', ref, profileId, requestId),
  write: (id, gen, data) => call('terminal:write', id, gen, data),
  resize: (id, gen, cols, rows) => call('terminal:resize', id, gen, cols, rows),
  ack: (id, gen, seq) => send('terminal:ack', id, gen, seq),
  focused: value => send('terminal:focused', value),
  rename: (id, title) => call('terminal:rename', id, title),
  close: (id, force) => call('terminal:close', id, force),
  restart: (id, force) => call('terminal:restart', id, force),
  clipboardRead: () => call('terminal:clipboardRead'),
  clipboardWrite: value => call('terminal:clipboardWrite', value),
  openLink: url => call('terminal:openLink', url),
  onEvent: cb => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      value: Parameters<TerminalBridge['onEvent']>[0] extends (event: infer E) => void ? E : never,
    ): void => cb(value)
    on('terminal:event', listener)
    return () => ipcRenderer.removeListener('terminal:event', listener)
  },
}
// 产物面板（docs/ui/artifacts-panel.md）：读取经过引擎核对改动记录；打开 / 显示只在本机
const artifacts: ArtifactsBridge = {
  list: input => call('engine:artifacts', input),
  change: input => call('engine:artifactChange', input),
  read: target => call('engine:artifactRead', target),
  open: target => call('artifacts:open', target),
  reveal: target => call('artifacts:reveal', target),
}
// 系统通知：要不要提醒由渲染层判断，主进程负责弹出（docs/ui/notifications.md）
const notifications: NotificationsBridge = {
  supported: () => call('notify:supported'),
  show: input => call('notify:show', input),
  onClick: cb => {
    const listener = (_event: Electron.IpcRendererEvent, value: NotificationClick): void => cb(value)
    on('notify:clicked', listener)
    return () => ipcRenderer.removeListener('notify:clicked', listener)
  },
}
// 系统托盘：托盘菜单的命令、勿扰状态、关闭主窗口时的行为（docs/ui/tray.md）
const tray: TrayBridge = {
  onCommand: cb => {
    const listener = (_event: Electron.IpcRendererEvent, value: TrayCommand): void => cb(value)
    on('tray:command', listener)
    return () => ipcRenderer.removeListener('tray:command', listener)
  },
  reportDnd: until => send('tray:dnd', until),
  prefs: () => call('tray:prefs'),
  setPrefs: patch => call('tray:setPrefs', patch),
}
// 协作频道（docs/ui/channels-phase-b.md §11）
const channels: ChannelsBridge = {
  state: () => call('channels:state'),
  messages: (id, before) => call('channels:messages', id, before),
  create: input => call('channels:create', input),
  update: (id, patch) => call('channels:update', id, patch),
  delete: id => call('channels:delete', id),
  post: (id, input) => call('channels:post', id, input),
  attachments: (id, messageId) => call('channels:attachments', id, messageId),
  markRead: id => call('channels:markRead', id),
  pin: (id, messageId, pinned) => call('channels:pin', id, messageId, pinned),
  search: (text, opts) => call('channels:search', text, opts),
  saveMember: (channelId, input) => call('channels:saveMember', channelId, input),
  addMember: (channelId, memberId) => call('channels:addMember', channelId, memberId),
  removeMember: (channelId, memberId) => call('channels:removeMember', channelId, memberId),
  deleteMember: memberId => call('channels:deleteMember', memberId),
  task: (taskId, action) => call('channels:task', taskId, action),
  approveTask: (taskId, approve) => call('channels:approveTask', taskId, approve),
  setAgentPolicy: (channelId, memberId, policy) => call('channels:agentPolicy', channelId, memberId, policy),
  createTeam: name => call('teams:create', name),
  updateTeam: (teamId, patch) => call('teams:update', teamId, patch),
  deleteTeam: teamId => call('teams:delete', teamId),
  setDisplayName: (teamId, name) => call('teams:rename', teamId, name),
  invite: (teamId, email, role) => call('teams:invite', teamId, email, role),
  revokeInvite: (teamId, inviteId) => call('teams:revokeInvite', teamId, inviteId),
  respondInvite: (inviteId, accept) => call('teams:respond', inviteId, accept),
  setRole: (teamId, userId, role) => call('teams:setRole', teamId, userId, role),
  removeTeamMember: (teamId, userId) => call('teams:removeMember', teamId, userId),
  refreshTeams: () => call('teams:refresh'),
  onChange: cb => {
    const listener = (_e: Electron.IpcRendererEvent, state: ChannelsSnapshot): void => cb(state)
    on('channels:changed', listener)
    return () => ipcRenderer.removeListener('channels:changed', listener)
  },
  onMessage: cb => {
    const listener = (_e: Electron.IpcRendererEvent, push: ChannelMessagePush): void => cb(push)
    on('channels:message', listener)
    return () => ipcRenderer.removeListener('channels:message', listener)
  },
}
// 手机远程连接：设置 › 手机（docs/mobile-remote.md §5.4）
const mobile: MobileBridge = {
  state: () => call('mobile:state'),
  setPrefs: patch => call('mobile:setPrefs', patch),
  pairStart: () => call('mobile:pairStart'),
  pairCancel: () => call('mobile:pairCancel'),
  pairDecide: accept => call('mobile:pairDecide', accept),
  revoke: id => call('mobile:revoke', id),
  setAccess: (id, access) => call('mobile:setAccess', id, access),
  onChange: cb => {
    const listener = (_event: Electron.IpcRendererEvent, value: MobileState): void => cb(value)
    on('mobile:changed', listener)
    return () => ipcRenderer.removeListener('mobile:changed', listener)
  },
}
// 设置云同步（docs/ui/settings-sync.md §5.1）
const settingsSync: SettingsSyncBridge = {
  pull: () => call('settings:pull'),
  push: changes => call('settings:push', changes),
  engine: () => call('settings:engine'),
  applyEngine: (key, value) => call('settings:applyEngine', key, value),
}
// 设置 › 反馈（docs/ui/feedback.md §5）
const feedback: FeedbackBridge = {
  state: () => call('feedback:state'),
  refresh: () => call('feedback:refresh'),
  list: before => call('feedback:list', before),
  get: id => call('feedback:get', id),
  create: input => call('feedback:create', input),
  reply: (id, input) => call('feedback:reply', id, input),
  close: id => call('feedback:close', id),
  preview: query => call('feedback:preview', query),
  attachment: (threadId, attachmentId) => call('feedback:attachment', threadId, attachmentId),
  pending: () => call('feedback:pending'),
  ack: ids => call('feedback:ack', ids),
  onChange: cb => {
    const listener = (_event: Electron.IpcRendererEvent, value: FeedbackChange): void => cb(value)
    on('feedback:changed', listener)
    return () => ipcRenderer.removeListener('feedback:changed', listener)
  },
}
contextBridge.exposeInMainWorld('pixelsky', {
  tray,
  feedback,
  channels,
  mobile,
  settingsSync,
  machines: {
    state: () => call('machines:state'),
    save: input => call('machines:save', input),
    connect: (id, fingerprint) => call('machines:connect', id, fingerprint),
    disconnect: id => call('machines:disconnect', id),
    remove: id => call('machines:remove', id),
    select: id => call('machines:select', id),
    chooseKey: () => call('machines:chooseKey'),
    directories: (id, path) => call('machines:directories', id, path),
    addProject: (id, path) => call('machines:addProject', id, path),
    wslList: () => call('machines:wslList'),
    wslCheck: id => call('machines:wslCheck', id),
    wslSetNode: (id, path) => call('machines:wslSetNode', id, path),
    wslTerminal: id => call('machines:wslTerminal', id),
    workspaces: id => call('machines:workspaces', id),
    openWorkspace: choice => call('machines:openWorkspace', choice),
    onChange: callback => {
      const listener = (_e: Electron.IpcRendererEvent, state: import('../shared/types/machines').MachineState) =>
        callback(state)
      on('machines:changed', listener)
      return () => ipcRenderer.removeListener('machines:changed', listener)
    },
  } satisfies import('./machines').MachineBridge,
  platform: process.platform,
  /** 拖进来 / 粘贴的文件在磁盘上的路径（GitHub #15）；不是本机文件时为空字符串 */
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  /** 演示模式：显示照参考图写的演示数据，而不是空界面 */
  demo: config.demo,
  /** 同步窗口底色；transparent 仅供其他平台的原生覆盖层使用。Windows 按钮自绘。 */
  setTheme: (theme: 'light' | 'dark', transparent = false, background?: string) =>
    send('theme:set', theme, transparent, background),
  setLocale: (locale: 'zh-CN' | 'en-US') => call('ui:locale', locale),
  account,
  platformCatalog: {
    groups: () => call('platform:groups'),
    models: (id: string) => call('platform:models', id),
  },
  providers: {
    list: () => call('providers:list'),
    save: input => call('providers:save', input),
    remove: id => call('providers:remove', id),
    test: input => call('providers:test', input),
    models: input => call('providers:models', input),
    onChange: callback => {
      const listener = (_e: Electron.IpcRendererEvent, state: import('../shared/types/providers').ProvidersState) =>
        callback(state)
      on('providers:changed', listener)
      return () => ipcRenderer.removeListener('providers:changed', listener)
    },
  } satisfies import('./providers').ProvidersBridge,
  sessionStatus: {
    get: () => call('sessionStatus:get'),
    refresh: sessionId => call('sessionStatus:refresh', sessionId),
    onChange: callback => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        state: import('../shared/types/session-status').SessionStatusState,
      ) => callback(state)
      on('sessionStatus:changed', listener)
      return () => ipcRenderer.removeListener('sessionStatus:changed', listener)
    },
  } satisfies import('../shared/types/session-status').SessionStatusBridge,
  ai: {
    commitMessage: request => call('ai:commitMessage', request),
    cancel: requestId => call('ai:cancel', requestId),
    commitCharge: requestId => call('ai:commitCharge', requestId),
  } satisfies import('./ai').AiBridge,
  engine,
  app: appInfo,
  log,
  update,
  files,
  editor,
  window: windowControls,
  projectTools,
  projectBrowser,
  terminal,
  notifications,
  artifacts,
  extensions: {
    state: ref => call('extensions:state', ref),
    save: data => call('extensions:save', data),
    import: data => call('extensions:import', data),
    importMcp: (json, scope) => call('extensions:importMcp', json, scope),
    toggle: (id, enabled) => call('extensions:toggle', id, enabled),
    remove: id => call('extensions:remove', id),
    check: (id, ref) => call('extensions:check', id, ref),
    update: (id, apply) => call('extensions:update', id, apply),
    skillText: (id, ref) => call('extensions:skillText', id, ref),
    choose: kind => call('extensions:choose', kind),
    reveal: (id, ref) => call('extensions:reveal', id, ref),
    commands: ref => call('extensions:commands', ref),
    onChange: callback => {
      const listener = (): void => callback()
      on('extensions:changed', listener)
      return () => ipcRenderer.removeListener('extensions:changed', listener)
    },
  } satisfies ExtensionsBridge,
  extpacks: {
    state: () => call('extpacks:state'),
    addFolder: path => call('extpacks:addFolder', path ?? null),
    onigWasm: () => call('extpacks:onigWasm'),
    setEnabled: (key, enabled) => call('extpacks:setEnabled', key, enabled),
    remove: key => call('extpacks:remove', key),
    reload: key => call('extpacks:reload', key ?? null),
    setOptions: (key, patch) => call('extpacks:setOptions', key, patch),
    readJson: (key, path) => call('extpacks:readJson', key, path),
    readText: (key, path) => call('extpacks:readText', key, path),
    reveal: key => call('extpacks:reveal', key),
    onChange: callback => {
      const listener = (): void => callback()
      on('extpacks:changed', listener)
      return () => ipcRenderer.removeListener('extpacks:changed', listener)
    },
  } satisfies ExtPacksBridge,
  extstore: {
    catalog: query => call('extstore:catalog', query),
    detail: id => call('extstore:detail', id),
    install: (id, version, options) => call('extstore:install', id, version, options ?? {}),
    cancel: id => call('extstore:cancel', id),
    checkUpdates: options => call('extstore:checkUpdates', options ?? {}),
    state: () => call('extstore:state'),
    refreshBlocklist: () => call('extstore:refreshBlocklist'),
    report: (id, input) => call('extstore:report', id, input),
    publisher: () => call('extstore:publisher'),
    register: name => call('extstore:register', name),
    pickUpload: input => call('extstore:pickUpload', input),
    upload: token => call('extstore:upload', token),
    withdraw: (id, version) => call('extstore:withdraw', id, version),
    delist: id => call('extstore:delist', id),
    relist: id => call('extstore:relist', id),
    publishCheck: (id, version) => call('extstore:publishCheck', id, version),
    onChange: callback => {
      const listener = (): void => callback()
      on('extstore:changed', listener)
      return () => ipcRenderer.removeListener('extstore:changed', listener)
    },
  } satisfies ExtStoreBridge,
})
