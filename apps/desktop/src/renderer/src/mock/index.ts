// 演示数据汇总：只由 main.tsx 在演示模式下动态加载，装进 data/demo.ts（docs/restructure.md §9.3）
import type { DemoSource } from '@/data/demo'
import { demoAccount } from './account'
import { demoArtifactChanges, demoArtifactPreview, demoArtifacts } from './artifacts'
import { demoContext } from './context'
import { demoQuota } from './quota'
import {
  animateCompaction,
  animateAutoFold,
  animateSteps,
  showcaseSnapshots,
  showcaseSubagentTranscript,
  showcaseTaskOutput,
} from './conversations'
import { codingSnapshots } from './coding'
import { workbenchSnapshots } from './workbench'
import { demo, demoIdleDays } from './demo'
import { DEMO_EDITOR_STATE, DEMO_FILES, demoDirectory, demoDocument } from './files'
import { demoGitBranches, demoGitDiff, demoGitHistory, demoGitStatus } from './git'
import { demoExtStore } from './extStore'
import { demoInbox, demoScheduledSessions } from './inbox'
import { demoConnectors } from './connectors'
import { demoSessionChecks } from './checks'
import { demoAccounts } from './accounts'
import { statusDemoInbox, statusDemoSessionState } from './statusDemo'
import { demoMachines, demoMachineProjects, demoMachineWorkspaces } from './machines'
import { DemoTuiPanel } from './DemoTuiPanel'
import { demoBoardTasks } from './board'
import {
  demoEngineCatalog,
  demoCodexCatalog,
  demoEngineConfig,
  demoEngineStatus,
  demoPlatformGroups,
  demoPlatformKeys,
  demoProviders,
} from './platform'
import { demoToolBrowser, demoToolCopies, demoToolEnvironment, demoToolRunTasks, demoToolTasks } from './projectTools'
import { demoRemoteCalls } from './remoteCalls'
import { demoSearchProjects, searchDemo } from './search'
import { demoSessions } from './sessionLifecycle'
import { demoRewindPreview, demoSideAnswer } from './branch'
import { codexResumeSnapshots, demoNativeSessions } from './native'
import { demoTerminalOutput, demoTerminalProfiles } from './terminal'
import { demoStore } from './store'
import { createDemoCheckout } from './checkout'
import { demoUsageRecords } from './usage'

const demoCheckout = createDemoCheckout(demoAccount, demoStore)

export const demoSource: DemoSource = {
  appData: demo,
  account: demoAccount,
  store: demoStore,
  checkout: demoCheckout,
  platformGroups: demoPlatformGroups,
  platformKeys: demoPlatformKeys,
  providers: demoProviders,
  engines: {
    status: demoEngineStatus,
    catalog: demoEngineCatalog,
    codexCatalog: demoCodexCatalog,
    config: demoEngineConfig,
  },
  artifacts: { response: demoArtifacts, changes: demoArtifactChanges, preview: demoArtifactPreview },
  context: demoContext,
  quota: demoQuota(),
  files: { contents: DEMO_FILES, editorState: DEMO_EDITOR_STATE, directory: demoDirectory, document: demoDocument },
  git: { status: demoGitStatus, branches: demoGitBranches, diff: demoGitDiff, history: demoGitHistory },
  extStore: demoExtStore,
  inbox: [...demoInbox, ...statusDemoInbox],
  sessionStatus: statusDemoSessionState,
  sessionChecks: demoSessionChecks,
  machines: demoMachines,
  machineProjects: demoMachineProjects,
  machineWorkspaces: demoMachineWorkspaces,
  tuiPanel: DemoTuiPanel,
  boardTasks: demoBoardTasks,
  scheduledSessions: demoScheduledSessions,
  connectors: demoConnectors,
  accounts: demoAccounts,
  projectTools: {
    tasks: demoToolTasks,
    runTasks: demoToolRunTasks,
    environment: demoToolEnvironment,
    copies: demoToolCopies,
    browser: demoToolBrowser,
  },
  remoteCalls: demoRemoteCalls,
  usageRecords: demoUsageRecords,
  search: { projects: demoSearchProjects, run: searchDemo },
  terminal: { profiles: demoTerminalProfiles, output: demoTerminalOutput },
  sessions: demoSessions,
  idleDays: demoIdleDays,
  conversations: {
    snapshots: {
      ...showcaseSnapshots,
      ...workbenchSnapshots,
      ...codingSnapshots,
      ...codexResumeSnapshots,
    },
    subagentTranscript: showcaseSubagentTranscript,
    taskOutput: showcaseTaskOutput,
    rewindPreview: demoRewindPreview,
    sideAnswer: demoSideAnswer,
    nativeSessions: demoNativeSessions,
    animate: update => {
      animateCompaction(update)
      animateSteps(update)
      animateAutoFold(update)
    },
  },
}
