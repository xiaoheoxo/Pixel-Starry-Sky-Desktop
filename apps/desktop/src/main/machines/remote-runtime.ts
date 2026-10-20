import { homedir, hostname, platform, arch } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { REMOTE_PROTOCOL, viaGateway, type IPC_CONTRACT, type SessionRecord } from '@pixelsky/protocol'
import { EngineHost, type EngineHostOptions } from '@pixelsky/engine'
import { WorkspaceFiles } from '../core/workspace-files'
import { resolveLocalWorkspace } from '../core/workspace/resolve'
import { FILE_OPS } from '../core/workspace/ops'
import { ENGINE_OPS, addProjectPath, usageCsv } from '../core/engine/ops'
import { PROJECT_TOOL_OPS, listWorkspaces } from '../core/project-tools/ops'
import { ProjectTools, createToolsHost } from '../core/project-tools/tools'
import { moveToTrash } from '../core/project-tools/trash'
import { SearchRegistry } from '../core/search-registry'
import { bindOps } from '../core/ops'
import { listDirectories } from '../core/directories'
import { gatewaySettings } from '../platform/compact-window'
import type { WorkspaceRef } from '../../shared/types/workspace'
import { TunnelEnd, type TunnelPeer } from './tunnel'
import { collectStats } from './stats'

type Handler = (...args: never[]) => unknown
type RemoteOf<Spec> = Spec extends { readonly remote: infer Method extends string } ? Method : never
/** Every method name the IPC contract declares in a `remote` field: each one needs an implementation below. */
type ContractMethod = RemoteOf<(typeof IPC_CONTRACT)[keyof typeof IPC_CONTRACT]>
/** Methods that serve no channel: the handshake, and the platform requests the helper sends back to the desktop. */
type HelperMethod =
  | 'hello'
  | 'platform:request'
  | 'platform:record'
  | 'platform:compaction'
  | 'tunnel:listen'
  | 'tunnel:connect'
  | 'stats'

export async function createRemoteRuntime(
  peer: TunnelPeer,
  dataDir = join(homedir(), '.local', 'share', 'pixelsky', 'remote', 'data'),
  extra: Partial<EngineHostOptions> = {},
) {
  const tunnel = new TunnelEnd(peer, 'remote')
  const environments = new Map<string, NodeJS.ProcessEnv>()
  const prepare = async (record: SessionRecord) => {
    if (!viaGateway(record)) {
      environments.delete(record.id)
      return
    }
    let env = await peer.call<NodeJS.ProcessEnv>('platform:environment', [record])
    if (record.engine === 'claude') {
      const file = join(dataDir, 'gateway', record.id + '.json')
      delete env.PIXELSKY_GATEWAY_SETTINGS
      const settings = gatewaySettings(env)
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(file, JSON.stringify(settings), { mode: 0o600 })
      env = { ...settings.env, PIXELSKY_GATEWAY_SETTINGS: file }
    }
    environments.set(record.id, env)
  }
  const host = new EngineHost({
    ...extra,
    dataDir: join(dataDir, 'engine'),
    emit: event => peer.event('engine:event', event),
    sessionEnv: record => environments.get(record.id) ?? {},
    validateInput: prepare,
    platformCharges: (settlement, _signal) => peer.call('platform:charges', [settlement]),
  })
  const resolve = (ref: WorkspaceRef) => resolveLocalWorkspace(host, ref)
  const tools = createToolsHost({ host: () => host, resolve, record: id => host.record(id) })
  const changed = () => peer.event('projectTools:changed', null)
  let outputTimer: ReturnType<typeof setTimeout> | null = null
  const outputChanged = () => {
    outputTimer ??= setTimeout(() => {
      outputTimer = null
      peer.event('projectTools:changed', { kind: 'output' })
    }, 300)
  }
  // 文件树删除：远端没有回收站，和 Git 面板一样移到数据目录的 trash/
  const files = new WorkspaceFiles(resolve, {
    trash: async (absolute, relative) => {
      await moveToTrash(join(dataDir, 'trash'), [{ absolute, relative }])
    },
    attachmentDir: join(dataDir, 'attachments'),
  })
  await files.cleanExpiredStages().catch(() => {})
  // Git 面板：远端没有回收站，放弃的未跟踪文件移到数据目录的 trash/（docs/ui/git-panel.md §2.4）
  const projectTools = new ProjectTools(join(dataDir, 'tools'), tools, changed, {
    outputChanged,
    trash: async list => {
      await moveToTrash(join(dataDir, 'trash'), list)
    },
  })
  await projectTools.init()
  // 远端只有桌面端一个调用方：搜索 / 产物扫描共用一个桶
  const owner = 'desktop'
  const toolsContext = { host: tools, tools: projectTools }
  const contractMethods: Record<ContractMethod, Handler> = {
    ...bindOps(ENGINE_OPS, {
      host,
      owner,
      searches: new SearchRegistry(),
      scans: new SearchRegistry(),
      tools,
      copyPath: (projectId, copyId) => projectTools.copyPath(projectId, copyId),
      beforeUpdate: prepare,
    }),
    ...bindOps(FILE_OPS, { files }),
    ...bindOps(PROJECT_TOOL_OPS, toolsContext),
    directories: (input?: string) => listDirectories(input),
    workspaces: projectId => listWorkspaces(toolsContext, projectId),
    'engine:addProject': path => addProjectPath(host, path),
    'engine:usageExport': q => usageCsv(host, q),
  }
  const helperMethods: Record<HelperMethod, Handler> = {
    hello: () => ({
      protocol: REMOTE_PROTOCOL,
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      home: homedir(),
      node: process.versions.node,
      shell: process.env.SHELL || '/bin/sh',
    }),
    'platform:request': (id, requestId, model, chargeId) => {
      const record = host.executionRecord(id)
      if (record) host.platformRequestContext(record)?.(requestId, model, chargeId)
    },
    'platform:record': id => host.executionRecord(id),
    'platform:compaction': (id, report) => host.compactionRequest(id, report),
    ...tunnel.methods,
    stats: () => collectStats(),
  }
  const methods: Record<string, Handler> = { ...helperMethods, ...contractMethods }
  return {
    host,
    resolve,
    async call(method: string, args: unknown[]) {
      if (!Object.hasOwn(methods, method)) throw new Error('REMOTE_UNSUPPORTED: ' + method)
      return methods[method](...(args as never[]))
    },
    async close() {
      tunnel.close()
      await Promise.allSettled([projectTools.shutdown(), host.shutdown()])
    },
  }
}
