import { homedir, hostname, platform, arch } from 'node:os'
import { basename, join, dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import {
  REMOTE_PROTOCOL,
  codedError,
  viaGateway,
  type EngineInfo,
  type HostEvent,
  type IPC_CONTRACT,
  type SessionRecord,
} from '@pixelsky/protocol'
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
import { REMOTE_CLI_NODE_MIN, remoteCliSupported } from './remote-cli'

/**
 * 桌面端没把像素星空命令行装到这台机器上时为什么（ssh.ts / wsl.ts 的 installCli 按同样的条件跳过）：
 * 架构不是 x64 / arm64、Node 低于 Pi 要的 22.19，否则是上传或安装失败了。给引擎列表里 pixel 的说明用
 */
export function remotePixelReason(node: string, machineArch: string): string {
  if (machineArch !== 'x64' && machineArch !== 'arm64')
    return codedError('remote.pixelArch', { arch: machineArch }).message
  if (!remoteCliSupported(node, machineArch))
    return codedError('remote.pixelNode', { version: node, min: REMOTE_CLI_NODE_MIN.join('.') }).message
  return codedError('remote.pixelInstall').message
}

/** 引擎列表里找不到命令行的 pixel 换上远程的原因；用户自己设了命令路径的不动（那是它自己的「找不到」） */
export function withRemotePixelReason(list: EngineInfo[], reason: string | null): EngineInfo[] {
  if (!reason) return list
  return list.map(e =>
    e.id === 'pixel' && e.status === 'missing' && e.launch !== 'custom' ? { ...e, message: reason } : e,
  )
}

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
  // 没装上像素星空命令行时，引擎列表里 pixel 写清楚原因（不然只有一句「找不到 pixelsky」）
  const pixelReason = extra.pixelCli ? null : remotePixelReason(process.versions.node, arch())
  const prepare = async (record: SessionRecord) => {
    // 像素星空的自有会话也要桌面端给的环境变量：设置 › 子智能体（和本机 platform.ts 一样每个像素星空会话都带）
    if (!viaGateway(record) && record.engine !== 'pixel') {
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
    // 删对话时它的文件夹里有文件：远端没有回收站，和文件树一样移到数据目录的 trash/
    trash: async path => {
      await moveToTrash(join(dataDir, 'trash'), [{ absolute: path, relative: basename(path) }])
    },
    checkpoints: true,
    emit: (event: HostEvent) =>
      peer.event(
        'engine:event',
        event.kind === 'engines' ? { ...event, engines: withRemotePixelReason(event.engines, pixelReason) } : event,
      ),
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
  const engineContext = {
    host,
    owner,
    searches: new SearchRegistry(),
    scans: new SearchRegistry(),
    tools,
    copyPath: (projectId: string, copyId: string) => projectTools.copyPath(projectId, copyId),
    projectTools: () => projectTools,
    beforeUpdate: prepare,
  }
  // 操作表照旧整张展开（contract.test 按 `...bindOps(表名,` 认方法），引擎列表再单独包一层：没装上命令行时写明原因
  const contractMethods: Record<ContractMethod, Handler> = {
    ...bindOps(ENGINE_OPS, engineContext),
    'engine:engines': async (force?: unknown) =>
      withRemotePixelReason((await ENGINE_OPS['engine:engines'](engineContext, force)) as EngineInfo[], pixelReason),
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
      // Windows 没有 SHELL：终端开 PowerShell（ssh.ts 的 windowsShellCommand 按它拼命令）
      shell: process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'),
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
