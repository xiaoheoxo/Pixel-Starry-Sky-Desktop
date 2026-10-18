import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { app, dialog, shell } from 'electron'
import { systemCipher } from '../app/system-cipher'
import { object, scope, text } from '@pixelsky/engine'
import type { ExtensionLaunch, ExtensionScope, SessionRecord } from '@pixelsky/protocol'
import type { WorkspaceRef } from '../../shared/types/workspace'
import * as ipc from '../ipc/guard'
import { ExtensionService } from './service'
import { selectedMachine, type AppContext } from '../app/context'
import { resolveWorkspace } from '../workspace/resolve'
import { HISTORY_SERVER_NAME, type HistoryServer } from '../engine/history-mcp'

/**
 * 扩展（MCP / 插件 / 技能 / 命令行）的主进程一侧：服务实现在 extensions/service.ts。
 * 服务在第一次用到时才创建（引擎启动会话时、或页面第一次请求时），引擎没加载时环境变量只用进程自己的。
 */
export class Extensions {
  private service: ExtensionService | null = null

  constructor(
    private readonly ctx: AppContext,
    private readonly history: HistoryServer | null = null,
  ) {}

  private env(engine: 'claude' | 'codex' | 'pixel' = 'claude'): Record<string, string> | undefined {
    return this.ctx.engine?.engineConfig()[engine].env
  }

  get(): ExtensionService {
    if (!this.service)
      this.service = new ExtensionService(join(app.getPath('userData'), 'extensions'), systemCipher, () => ({
        ...process.env,
        ...this.env(),
      }))
    return this.service
  }

  /** 会话启动前：给引擎准备这个工作目录生效的扩展 */
  async prepare(record: SessionRecord): Promise<ExtensionLaunch> {
    // 换过引擎的对话：额外挂一个只读的对话历史 MCP 服务器，新引擎可以按需查更早的部分
    const history = await this.history?.entry(record)
    const base = this.get().launch(
      record.cwd,
      record.engine,
      this.env(record.engine),
      history
        ? {
            [HISTORY_SERVER_NAME]: {
              type: 'http',
              url: history.url,
              headers: { Authorization: `Bearer ${history.token}` },
            },
          }
        : {},
    )
    // 历史工具只读，不用每次查都等用户批准
    const launch = history ? { ...base, allowTools: [`mcp__${HISTORY_SERVER_NAME}`] } : base
    // 扩展包里的技能：Claude 走生成的插件目录，Codex 走技能目录；没有时 key 和原来一字不差
    const packs = this.ctx.extPacks?.skillLaunch(record.engine)
    if (!packs) return launch
    return {
      ...launch,
      key: packs.key ? launch.key + '|packs:' + packs.key : launch.key,
      pluginDirs: [...launch.pluginDirs, ...packs.pluginDirs],
      ...(packs.skillRoots.length > 0 ? { skillRoots: [...(launch.skillRoots ?? []), ...packs.skillRoots] } : {}),
    }
  }

  register(): void {
    const { ctx } = this
    const project = (raw: unknown): string | null => {
      if (raw == null) return null
      const ref = object(raw)
      return realpathSync(resolveWorkspace(ctx, ref as WorkspaceRef).path)
    }
    const checkedScope = (raw: unknown): ExtensionScope => {
      const s = scope(raw)
      if (s.kind === 'project') {
        // 渲染进程只能选已注册项目；传入路径由项目列表核对。
        if (
          !ctx.engine
            ?.projects()
            .map(p => p.path)
            .some(path => {
              try {
                return realpathSync(path).toLowerCase() === s.path.toLowerCase()
              } catch {
                return false
              }
            })
        )
          throw new Error('先添加该项目再设置项目范围')
      }
      return s
    }
    const handle = (name: string, fn: (...args: unknown[]) => unknown): void => {
      ipc.handle(`extensions:${name}` as ipc.InvokeChannel, (_event, ...args) => {
        if (selectedMachine(ctx) !== 'local') {
          if (name === 'commands') return []
          throw new Error('SSH_EXTENSIONS_REMOTE')
        }
        return fn(...args)
      })
    }
    const service = () => this.get()
    // 广播 extensions:changed 前先作废原生扩展缓存，各输入框收到后重新请求拿到的才是新的
    const changed = (): void => {
      this.service?.invalidateNative()
      ctx.events.broadcast('extensions:changed')
    }
    const mutate = async <T>(fn: () => Promise<T> | T): Promise<T> => {
      const value = await service().mutate(fn)
      changed()
      return value
    }
    handle('state', ref => service().state(project(ref)))
    handle('save', raw => {
      const data = object(raw)
      return mutate(() => service().upsert({ ...data, scope: checkedScope(data.scope) }))
    })
    handle('import', raw => {
      const data = object(raw)
      return mutate(async () => {
        const s = checkedScope(data.scope),
          e = await service().import({ ...data, scope: s })
        return service()
          .state(s.kind === 'project' ? s.path : null)
          .entries.find(x => x.id === e.id)!
      })
    })
    handle('importMcp', (json, s) =>
      mutate(() => service().importMcp(text(json, 'JSON', 2 * 1024 * 1024), checkedScope(s))),
    )
    handle('toggle', (id, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('开关值不正确')
      return mutate(() => service().toggle(text(id, 'id'), enabled))
    })
    handle('remove', id => mutate(() => service().remove(text(id, 'id'))))
    handle('check', (id, ref) => mutate(() => service().check(text(id, 'id'), project(ref))))
    handle('update', (id, apply) => mutate(() => service().update(text(id, 'id'), apply === true)))
    handle('skillText', (id, ref) => service().skillText(text(id, 'id'), project(ref)))
    handle('commands', ref => {
      const seen = new Set<string>()
      return [...service().commands(project(ref)), ...(ctx.extPacks?.skillCommands() ?? [])].filter(
        c => !seen.has(c.name) && !!seen.add(c.name),
      )
    })
    handle('reveal', (id, ref) => {
      shell.showItemInFolder(service().location(text(id, 'id'), project(ref)))
    })
    handle('choose', async kind => {
      const selected =
        kind === 'program'
          ? await dialog.showOpenDialog({ title: '选择命令行程序', properties: ['openFile'] })
          : await dialog.showOpenDialog({ title: '选择插件或技能目录', properties: ['openDirectory'] })
      return selected.canceled ? null : (selected.filePaths[0] ?? null)
    })
    // 扩展包的技能变了，输入框的技能列表也要刷新
    ctx.extPacks?.onChange(changed)
    // 用户常在终端里装了 skill 再切回来：窗口重新获得焦点时丢掉缓存，下一次请求重新扫描
    app.on('browser-window-focus', () => this.service?.invalidateNative())
    app.on('will-quit', () => this.service?.close())
  }
}
