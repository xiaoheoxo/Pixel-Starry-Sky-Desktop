import { readFileSync } from 'node:fs'
import { IPC_CONTRACT, type IpcChannelSpec } from '@pixelsky/protocol'
import { describe, expect, it } from 'vitest'
import { remoteArguments } from './identity'
import { resolveRoute, type Route } from './routing'

// 黄金用例：期望值由重构前的 Machines.invoke / remoteArguments 实现生成，再写成字面量。
// 路由码：A=聚合项目 B=聚合会话 L=本机 P=SSH_USE_WORKSPACE_PICKER C=files:copyPath T=files:target
//        U1/U2=engine:usageExport 走机器 1 / 2  R1/R2=转发到机器 1 / 2
const L = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const U = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const M1 = 'ssh-11111111-1111-4111-8111-111111111111'
const M2 = 'ssh-22222222-2222-4222-8222-222222222222'
const R1 = M1 + '~' + U
const R2 = M2 + '~' + U

/** 参数形状；顺序与下面每组 20 个路由码一一对应。 */
const routeShapes: unknown[][] = [
  [],
  [L],
  [R1],
  [R2],
  [L, R1],
  [R1, L],
  ['hello', R1],
  [null, R1],
  [{ projectId: L }],
  [{ sessionId: L }],
  [{ projectId: L, sessionId: R1 }],
  [{ projectId: R1, sessionId: L }],
  [{ projectId: R1 }],
  [{ sessionId: R1 }],
  [{ id: R1 }],
  [{ id: L }],
  [{ other: R1 }],
  [[R1]],
  [[{ projectId: R1 }]],
  [{ text: 'x' }],
]
/** 当前机器：本机、机器 1、机器 2；每个轮廓的三个字符串依次对应。 */
const currents = ['local', M1, M2]

/** 参数解码的形状；顺序与下面每组 12 个结果一一对应（<R>=远端资源 ID，<U>=解码后的 uuid，<L>=本机 uuid）。 */
const decodeShapes: unknown[][] = [
  [],
  [R1],
  [R1, R1],
  [R1, R1, R1, R1],
  ['hello', R1],
  [L, R1],
  [R2, R1],
  [null, R1],
  [{ projectId: R1, input: { id: R1 }, text: R1 }],
  [{ ids: [R1, 'x'] }, R1],
  [[R1, { sessionId: R1 }]],
  [R1, { content: R1, sessionId: R1 }, R1],
]

const routeProfiles: Record<string, [string, string, string]> = {
  plain: [
    'L L R1 R2 L R1 L L L L R1 R1 R1 R1 R1 L L L L L',
    'R1 R1 R1 R2 R1 R1 R1 R1 L L R1 R1 R1 R1 R1 R1 R1 R1 R1 R1',
    'R2 R2 R1 R2 R2 R1 R2 R2 L L R1 R1 R1 R1 R1 R2 R2 R2 R2 R2',
  ],
  picker: [
    'L L P P L P L L L L P P P P P L L L L L',
    'P P P P P P P P L L P P P P P P P P P P',
    'P P P P P P P P L L P P P P P P P P P P',
  ],
  resource: [
    'L L R1 R2 L R1 L L L L R1 R1 R1 R1 R1 L L L L L',
    'L L R1 R2 L R1 L L L L R1 R1 R1 R1 R1 L L L L L',
    'L L R1 R2 L R1 L L L L R1 R1 R1 R1 R1 L L L L L',
  ],
  projects: [
    'A A A A A A A A A A A A A A A A A A A A',
    'A A A A A A A A A A A A A A A A A A A A',
    'A A A A A A A A A A A A A A A A A A A A',
  ],
  sessions: [
    'B B B B B B B B B B B B B B B B B B B B',
    'B B B B B B B B B B B B B B B B B B B B',
    'B B B B B B B B B B B B B B B B B B B B',
  ],
  usageExport: [
    'L L U1 U2 L U1 L L L L U1 U1 U1 U1 U1 L L L L L',
    'U1 U1 U1 U2 U1 U1 U1 U1 L L U1 U1 U1 U1 U1 U1 U1 U1 U1 U1',
    'U2 U2 U1 U2 U2 U1 U2 U2 L L U1 U1 U1 U1 U1 U2 U2 U2 U2 U2',
  ],
  copyPath: [
    'L L C C L C L L L L C C C C C L L L L L',
    'C C C C C C C C L L C C C C C C C C C C',
    'C C C C C C C C L L C C C C C C C C C C',
  ],
  hostOnly: [
    'L L L L L L L L L L L L L L L L L L L L',
    'L L L L L L L L L L L L L L L L L L L L',
    'L L L L L L L L L L L L L L L L L L L L',
  ],
  target: [
    'L L T T L T L L L L T T T T T L L L L L',
    'T T T T T T T T L L T T T T T T T T T T',
    'T T T T T T T T L L T T T T T T T T T T',
  ],
  resourcePicker: [
    'L L P P L P L L L L P P P P P L L L L L',
    'L L P P L P L L L L P P P P P L L L L L',
    'L L P P L P L L L L P P P P P L L L L L',
  ],
}
const routeChannels: Record<string, string> = {
  'editor:choose': 'plain',
  'editor:open': 'picker',
  'editor:preferences': 'plain',
  'editor:remove': 'plain',
  'editor:state': 'plain',
  'engine:addProject': 'picker',
  'engine:addProjects': 'picker',
  'engine:answer': 'resource',
  'engine:archiveSession': 'resource',
  'engine:artifactChange': 'plain',
  'engine:artifactRead': 'plain',
  'engine:artifacts': 'plain',
  'engine:cancelQueued': 'resource',
  'engine:cancelSearch': 'plain',
  'engine:catalog': 'plain',
  'engine:compact': 'resource',
  'engine:config': 'plain',
  'engine:context': 'resource',
  'engine:createSession': 'plain',
  'engine:defaults': 'plain',
  'engine:deleteSession': 'resource',
  'engine:dismissQueued': 'resource',
  'engine:engines': 'plain',
  'engine:interrupt': 'resource',
  'engine:image': 'resource',
  'engine:itemDetail': 'resource',
  'engine:interruptTurn': 'resource',
  'engine:moveQueued': 'resource',
  'engine:openSession': 'resource',
  'engine:openSessionTail': 'resource',
  'engine:pickFolders': 'picker',
  'engine:projects': 'projects',
  'engine:removeProject': 'resource',
  'engine:renameProject': 'resource',
  'engine:renameSession': 'resource',
  'engine:resumeQueue': 'resource',
  'engine:retrySettings': 'plain',
  'engine:rewind': 'resource',
  'engine:rewindPreview': 'resource',
  'engine:undoRewind': 'resource',
  'engine:fork': 'resource',
  'engine:cancelNativeImport': 'resource',
  'engine:importNativeSession': 'resource',
  'engine:nativeSessionAction': 'resource',
  'engine:nativeSessionDetails': 'resource',
  'engine:nativeSessions': 'resource',
  'engine:sideQuestion': 'resource',
  'engine:cancelSideQuestion': 'resource',
  'engine:runQueuedNow': 'resource',
  'engine:search': 'plain',
  'engine:send': 'resource',
  'engine:sessions': 'sessions',
  'engine:setConfig': 'plain',
  'engine:setDefaultEngine': 'plain',
  'engine:setProjectFolders': 'resource',
  'engine:setRetrySettings': 'plain',
  'engine:setSessionBottom': 'resource',
  'engine:setSessionPinned': 'resource',
  'engine:steerQueued': 'resource',
  'engine:mcp': 'resource',
  'engine:stopTask': 'resource',
  'engine:subagentTranscript': 'resource',
  'engine:taskOutput': 'resource',
  'engine:update': 'plain',
  'engine:importCandidates': 'picker',
  'engine:install': 'plain',
  'engine:login': 'plain',
  'engine:loginInput': 'plain',
  'engine:loginCancel': 'plain',
  'engine:logout': 'plain',
  'engine:accounts': 'plain',
  'engine:accountsQuota': 'plain',
  'engine:accountAdd': 'plain',
  'engine:accountRelogin': 'plain',
  'engine:accountSwitch': 'plain',
  'engine:accountRemove': 'plain',
  'engine:accountUpdate': 'plain',
  'engine:accountAuto': 'plain',
  'engine:updateSession': 'resource',
  'engine:usageClear': 'plain',
  'engine:usageExport': 'usageExport',
  'engine:usageList': 'plain',
  'engine:usageSummary': 'plain',
  'files:copyPath': 'copyPath',
  'files:create': 'plain',
  'files:finishClose': 'hostOnly',
  'files:grep': 'plain',
  'files:headContent': 'plain',
  'files:list': 'plain',
  'files:read': 'plain',
  'files:remove': 'plain',
  'files:rename': 'plain',
  'files:reveal': 'picker',
  'files:save': 'plain',
  'files:search': 'plain',
  'files:stage': 'plain',
  'files:status': 'plain',
  'files:target': 'target',
  'projectTools:branches': 'resource',
  'projectTools:chooseDirectory': 'picker',
  'projectTools:copies': 'resource',
  'projectTools:createCopy': 'resource',
  'projectTools:createTask': 'resource',
  'projectTools:deleteService': 'resource',
  'projectTools:deleteTask': 'resource',
  'projectTools:environment': 'plain',
  'projectTools:runTasks': 'plain',
  'projectTools:gradleTasks': 'plain',
  'projectTools:gradleTasksCancel': 'plain',
  'projectTools:forgetCopy': 'resource',
  'projectTools:gitBranches': 'plain',
  'projectTools:gitCommit': 'plain',
  'projectTools:gitCommitContext': 'plain',
  'projectTools:gitCompare': 'plain',
  'projectTools:gitCreateBranch': 'plain',
  'projectTools:gitDiff': 'plain',
  'projectTools:gitDiscard': 'plain',
  'projectTools:gitFetch': 'plain',
  'projectTools:gitHistoryAction': 'plain',
  'projectTools:gitLog': 'plain',
  'projectTools:gitOperation': 'plain',
  'projectTools:gitPull': 'plain',
  'projectTools:gitPush': 'plain',
  'projectTools:gitRefs': 'plain',
  'projectTools:gitShow': 'plain',
  'projectTools:gitStage': 'plain',
  'projectTools:gitStatus': 'plain',
  'projectTools:gitSwitch': 'plain',
  'projectTools:gitUnstage': 'plain',
  'projectTools:openCopy': 'resource',
  'projectTools:openExternal': 'hostOnly',
  'projectTools:openPath': 'picker',
  'projectTools:portStatus': 'plain',
  'projectTools:previewCopy': 'resource',
  'projectTools:removeCopy': 'resource',
  'projectTools:reorderTasks': 'resource',
  'projectTools:restartService': 'resource',
  'projectTools:revealCopy': 'resourcePicker',
  'projectTools:saveService': 'plain',
  'projectTools:pinTask': 'resource',
  'projectTools:pinnedTasks': 'plain',
  'projectTools:allTasks': 'plain',
  'projectTools:searchTasks': 'plain',
  'projectTools:services': 'plain',
  'projectTools:startService': 'resource',
  'projectTools:stopService': 'resource',
  'projectTools:tasks': 'resource',
  'projectTools:updateTask': 'resource',
  'terminal:clipboardRead': 'hostOnly',
  'terminal:clipboardWrite': 'hostOnly',
  'terminal:openLink': 'hostOnly',
  'x:unknown': 'plain',
}
const decodeProfiles: Record<string, string[]> = {
  first: [
    '[]',
    '["<U>"]',
    '["<U>","<R>"]',
    '["<U>","<R>","<R>","<R>"]',
    '["hello","<R>"]',
    '["<L>","<R>"]',
    '["ssh-22222222-2222-4222-8222-222222222222~<U>","<R>"]',
    '[null,"<R>"]',
    '[{"projectId":"<U>","input":{"id":"<R>"},"text":"<R>"}]',
    '[{"ids":["<U>","x"]},"<R>"]',
    '[["<U>",{"sessionId":"<U>"}]]',
    '["<U>",{"content":"<R>","sessionId":"<U>"},"<R>"]',
  ],
  firstAndSecond: [
    '[]',
    '["<U>"]',
    '["<U>","<U>"]',
    '["<U>","<U>","<R>","<R>"]',
    '["hello","<U>"]',
    '["<L>","<U>"]',
    '["ssh-22222222-2222-4222-8222-222222222222~<U>","<U>"]',
    '[null,"<U>"]',
    '[{"projectId":"<U>","input":{"id":"<R>"},"text":"<R>"}]',
    '[{"ids":["<U>","x"]},"<U>"]',
    '[["<U>",{"sessionId":"<U>"}]]',
    '["<U>",{"content":"<R>","sessionId":"<U>"},"<R>"]',
  ],
  firstSecondThird: [
    '[]',
    '["<U>"]',
    '["<U>","<U>"]',
    '["<U>","<U>","<U>","<R>"]',
    '["hello","<U>"]',
    '["<L>","<U>"]',
    '["ssh-22222222-2222-4222-8222-222222222222~<U>","<U>"]',
    '[null,"<U>"]',
    '[{"projectId":"<U>","input":{"id":"<R>"},"text":"<R>"}]',
    '[{"ids":["<U>","x"]},"<U>"]',
    '[["<U>",{"sessionId":"<U>"}]]',
    '["<U>",{"content":"<R>","sessionId":"<U>"},"<U>"]',
  ],
  second: [
    '[]',
    '["<R>"]',
    '["<R>","<U>"]',
    '["<R>","<U>","<R>","<R>"]',
    '["hello","<U>"]',
    '["<L>","<U>"]',
    '["ssh-22222222-2222-4222-8222-222222222222~<U>","<U>"]',
    '[null,"<U>"]',
    '[{"projectId":"<U>","input":{"id":"<R>"},"text":"<R>"}]',
    '[{"ids":["<U>","x"]},"<U>"]',
    '[["<U>",{"sessionId":"<U>"}]]',
    '["<R>",{"content":"<R>","sessionId":"<U>"},"<R>"]',
  ],
}
const decodeChannels: Record<string, string> = {
  'editor:choose': 'first',
  'editor:open': 'first',
  'editor:preferences': 'first',
  'editor:remove': 'first',
  'editor:state': 'first',
  'engine:addProject': 'first',
  'engine:addProjects': 'first',
  'engine:answer': 'firstAndSecond',
  'engine:archiveSession': 'first',
  'engine:artifactChange': 'first',
  'engine:artifactRead': 'first',
  'engine:artifacts': 'first',
  'engine:cancelQueued': 'firstAndSecond',
  'engine:cancelSearch': 'first',
  'engine:catalog': 'first',
  'engine:compact': 'first',
  'engine:config': 'first',
  'engine:context': 'first',
  'engine:createSession': 'first',
  'engine:defaults': 'first',
  'engine:deleteSession': 'first',
  'engine:dismissQueued': 'firstAndSecond',
  'engine:engines': 'first',
  'engine:interrupt': 'first',
  'engine:image': 'firstAndSecond',
  'engine:itemDetail': 'firstAndSecond',
  'engine:interruptTurn': 'firstAndSecond',
  'engine:moveQueued': 'firstAndSecond',
  'engine:openSession': 'first',
  'engine:openSessionTail': 'first',
  'engine:pickFolders': 'first',
  'engine:projects': 'first',
  'engine:removeProject': 'first',
  'engine:renameProject': 'first',
  'engine:renameSession': 'first',
  'engine:resumeQueue': 'first',
  'engine:retrySettings': 'first',
  'engine:rewind': 'firstAndSecond',
  'engine:rewindPreview': 'firstAndSecond',
  'engine:undoRewind': 'first',
  'engine:fork': 'firstAndSecond',
  'engine:cancelNativeImport': 'first',
  'engine:importNativeSession': 'first',
  'engine:nativeSessionAction': 'first',
  'engine:nativeSessionDetails': 'first',
  'engine:nativeSessions': 'first',
  'engine:sideQuestion': 'first',
  'engine:cancelSideQuestion': 'first',
  'engine:runQueuedNow': 'firstAndSecond',
  'engine:search': 'first',
  'engine:send': 'first',
  'engine:sessions': 'first',
  'engine:setConfig': 'first',
  'engine:setDefaultEngine': 'first',
  'engine:setProjectFolders': 'first',
  'engine:setRetrySettings': 'first',
  'engine:setSessionBottom': 'first',
  'engine:setSessionPinned': 'first',
  'engine:steerQueued': 'firstSecondThird',
  'engine:mcp': 'first',
  'engine:stopTask': 'firstAndSecond',
  'engine:subagentTranscript': 'firstAndSecond',
  'engine:taskOutput': 'firstAndSecond',
  'engine:update': 'first',
  'engine:importCandidates': 'first',
  'engine:install': 'first',
  'engine:login': 'first',
  'engine:loginInput': 'first',
  'engine:loginCancel': 'first',
  'engine:logout': 'first',
  'engine:accounts': 'first',
  'engine:accountsQuota': 'first',
  'engine:accountAdd': 'first',
  'engine:accountRelogin': 'first',
  'engine:accountSwitch': 'first',
  'engine:accountRemove': 'first',
  'engine:accountUpdate': 'first',
  'engine:accountAuto': 'first',
  'engine:updateSession': 'first',
  'engine:usageClear': 'first',
  'engine:usageExport': 'first',
  'engine:usageList': 'first',
  'engine:usageSummary': 'first',
  'files:copyPath': 'first',
  'files:create': 'first',
  'files:finishClose': 'first',
  'files:grep': 'first',
  'files:headContent': 'first',
  'files:list': 'first',
  'files:read': 'first',
  'files:remove': 'first',
  'files:rename': 'first',
  'files:reveal': 'first',
  'files:save': 'first',
  'files:search': 'first',
  'files:stage': 'first',
  'files:status': 'first',
  'files:target': 'first',
  'projectTools:branches': 'first',
  'projectTools:chooseDirectory': 'first',
  'projectTools:copies': 'first',
  'projectTools:createCopy': 'first',
  'projectTools:createTask': 'first',
  'projectTools:deleteService': 'first',
  'projectTools:deleteTask': 'first',
  'projectTools:environment': 'first',
  'projectTools:runTasks': 'first',
  'projectTools:gradleTasks': 'first',
  'projectTools:gradleTasksCancel': 'first',
  'projectTools:forgetCopy': 'first',
  'projectTools:gitBranches': 'first',
  'projectTools:gitCommit': 'first',
  'projectTools:gitCommitContext': 'first',
  'projectTools:gitCompare': 'first',
  'projectTools:gitCreateBranch': 'first',
  'projectTools:gitDiff': 'first',
  'projectTools:gitDiscard': 'first',
  'projectTools:gitFetch': 'first',
  'projectTools:gitHistoryAction': 'first',
  'projectTools:gitLog': 'first',
  'projectTools:gitOperation': 'first',
  'projectTools:gitPull': 'first',
  'projectTools:gitPush': 'first',
  'projectTools:gitRefs': 'first',
  'projectTools:gitShow': 'first',
  'projectTools:gitStage': 'first',
  'projectTools:gitStatus': 'first',
  'projectTools:gitSwitch': 'first',
  'projectTools:gitUnstage': 'first',
  'projectTools:openCopy': 'first',
  'projectTools:openExternal': 'first',
  'projectTools:openPath': 'first',
  'projectTools:portStatus': 'first',
  'projectTools:previewCopy': 'first',
  'projectTools:removeCopy': 'first',
  'projectTools:reorderTasks': 'first',
  'projectTools:restartService': 'first',
  'projectTools:revealCopy': 'first',
  'projectTools:saveService': 'first',
  'projectTools:pinTask': 'first',
  'projectTools:pinnedTasks': 'first',
  'projectTools:allTasks': 'first',
  'projectTools:searchTasks': 'second',
  'projectTools:services': 'first',
  'projectTools:startService': 'first',
  'projectTools:stopService': 'first',
  'projectTools:tasks': 'first',
  'projectTools:updateTask': 'first',
  'terminal:clipboardRead': 'first',
  'terminal:clipboardWrite': 'first',
  'terminal:openLink': 'first',
  'x:unknown': 'first',
}

function code(route: Route): string {
  switch (route.kind) {
    case 'aggregate':
      return route.what === 'projects' ? 'A' : 'B'
    case 'local':
      return 'L'
    case 'picker':
      return 'P'
    case 'copyPath':
      return 'C'
    case 'target':
      return 'T'
    case 'usageExport':
      return 'U' + (route.machine === M1 ? '1' : '2')
    case 'remote':
      return 'R' + (route.machine === M1 ? '1' : '2')
  }
}
const show = (value: unknown): string =>
  JSON.stringify(value).split(R1).join('<R>').split(U).join('<U>').split(L).join('<L>').split(M1).join('<M1>')
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))

describe('resolveRoute golden table', () => {
  it('covers every channel that passes through Machines.invoke', () => {
    expect(Object.keys(routeChannels)).toHaveLength(Object.keys(decodeChannels).length)
    expect(Object.keys(routeChannels).sort()).toEqual(Object.keys(decodeChannels).sort())
    expect(Object.keys(routeChannels).length).toBeGreaterThan(100)
  })
  for (const [channel, profile] of Object.entries(routeChannels)) {
    it(channel, () => {
      const actual = currents.map(current => routeShapes.map(args => code(resolveRoute(channel, copy(args), current))))
      expect(actual.map(row => row.join(' '))).toEqual(routeProfiles[profile])
    })
  }
  it('routes wsl machine resources to that machine', () => {
    const wsl = 'wsl-33333333-3333-4333-8333-333333333333'
    expect(resolveRoute('engine:send', [wsl + '~' + U], L)).toEqual({ kind: 'remote', machine: wsl })
    expect(resolveRoute('engine:send', [{ sessionId: wsl + '~' + U }], M1)).toEqual({ kind: 'remote', machine: wsl })
  })
  it('does not mutate arguments', () => {
    const args = [{ projectId: R1, nested: { id: L } }, R1]
    const before = JSON.stringify(args)
    resolveRoute('engine:send', args, M1)
    expect(JSON.stringify(args)).toBe(before)
  })
  it('stays free of electron imports', () => {
    const source = readFileSync(new URL('./routing.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from\s+['"]electron['"]/)
  })
})

describe('remoteArguments golden table', () => {
  for (const [channel, profile] of Object.entries(decodeChannels)) {
    it(channel, () => {
      const actual = decodeShapes.map(args => show(remoteArguments(channel, copy(args), M1)))
      expect(actual).toEqual(decodeProfiles[profile])
    })
  }
})

// ---------------------------------------------------------------------------
// 契约一致性：resolveRoute 和 remoteArguments 都从 packages/protocol 的 IPC_CONTRACT 推导，这里验证契约列出的通道集合与 ids
// ---------------------------------------------------------------------------
const contract = IPC_CONTRACT as Record<string, IpcChannelSpec>
/** 经过 Machines.invoke 的路由档位；local / self / push 的通道不会走到 resolveRoute */
const invoked = new Set(['aggregate', 'selected', 'resource', 'hostOnly'])
/** routeChannels 里列出、但实际不经过 Machines.invoke 的通道（workspace/files-ipc.ts 只让 files:* 和 editor:open 走 invoke） */
const notInvoked = ['editor:choose', 'editor:preferences', 'editor:remove', 'editor:state']

describe('IPC contract agrees with resolveRoute', () => {
  const routed = Object.keys(contract).filter(channel => invoked.has(contract[channel].route))
  const listed = Object.keys(routeChannels).filter(channel => channel !== 'x:unknown')
  it('declares exactly the channels that pass through Machines.invoke', () => {
    expect(routed.sort()).toEqual(listed.filter(channel => !notInvoked.includes(channel)).sort())
    for (const channel of notInvoked) expect(['local', 'self']).toContain(contract[channel].route)
  })
  it('keeps ids in step with remoteArguments for every remote method', () => {
    const remote = Object.entries(contract).filter(([, spec]) => spec.remote)
    expect(remote.length).toBeGreaterThan(80)
    for (const [channel, spec] of remote) {
      const decoded = remoteArguments(spec.remote!, [R1, R1, R1, R1], M1)
        .map((value, index) => (value === U ? index : -1))
        .filter(index => index >= 0)
      expect(decoded, channel).toEqual([...(spec.ids ?? [])])
    }
    for (const [channel, spec] of Object.entries(contract)) expect(!!spec.ids, channel).toBe(!!spec.remote)
  })
})
