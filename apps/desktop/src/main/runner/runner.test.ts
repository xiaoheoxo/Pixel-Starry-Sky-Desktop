import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from '../../shared/types/channels'
import { readAccount } from './account'
import { cleanRunnerConfig, runnerAgent, runnerConfig } from './config'
import { runnerFetch } from './daemon'
import { configure, install, remove, runnerPaths, state, type Exec } from './install'
import { systemdArg, unitText, wrapperText } from './unit'

const member = (patch: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    id: 'm1',
    name: '前端助手',
    engine: 'claude',
    machineId: 'ssh-1',
    projectId: 'ssh-1~p1',
    copyId: null,
    sharedSessionId: null,
    settings: { model: 'sonnet', platform: { groupId: 'g' }, provider: 'x' },
    instructions: '只改前端',
    mode: 'shared',
    createdAt: 1,
    ...patch,
  }) as unknown as AgentConfig

const teammate = { newSession: true, permission: null, copy: true, mcp: false, projects: ['ssh-1~p1', 'p-local'] }

describe('执行机配置', () => {
  it('桌面推的：只带 Claude Code / Codex、项目换成路径，队友限制的项目也换成路径', () => {
    const config = runnerConfig({
      installer: 'dev-A',
      locale: 'zh-CN',
      selfName: '林夏',
      members: [member(), member({ id: 'm2', engine: 'pixel' }), member({ id: 'm3', projectId: 'gone' })],
      teammate: teammate as never,
      projectPath: id => (id === 'ssh-1~p1' ? '/srv/web' : null),
    })
    expect(config.members.map(m => m.id)).toEqual(['m1'])
    expect(config.members[0]).toMatchObject({ projectPath: '/srv/web' })
    expect(config.members[0]).not.toHaveProperty('machineId')
    expect(config.teammate.projects).toEqual(['/srv/web'])
  })

  it('执行机读的：平台额度、自定义接口去掉，每项活新开会话，认不出的成员丢掉', () => {
    const raw = {
      format: 1,
      installer: 'dev-A',
      locale: 'en-US',
      selfName: '林夏',
      teammate,
      members: [
        { ...member(), projectPath: '/srv/web' },
        { ...member(), projectPath: '/srv/web' },
        { ...member({ id: 'm2' }), projectPath: 'relative/path' },
        { ...member({ id: 'm3', engine: 'pixel' }), projectPath: '/srv/x' },
      ],
    }
    const config = cleanRunnerConfig(raw)!
    expect(config.locale).toBe('en-US')
    expect(config.members).toHaveLength(1)
    expect(config.members[0].settings).toEqual({ model: 'sonnet' })
    expect(config.members[0].mode).toBe('per-task')
    expect(runnerAgent(config.members[0], 'p9')).toMatchObject({ machineId: 'local', projectId: 'p9', copyId: null })
    expect(cleanRunnerConfig({ ...raw, format: 2 })).toBeNull()
    expect(cleanRunnerConfig({ ...raw, installer: '' })).toBeNull()
  })
})

describe('systemd 单元和小脚本', () => {
  it('路径带空格、引号、%：照 systemd 的规则转义；换行直接拒绝', () => {
    expect(systemdArg('/a b/"c"%d\\e')).toBe('"/a b/\\"c\\"%%d\\\\e"')
    expect(() => systemdArg('/a\nb')).toThrow()
    const unit = unitText({ node: '/usr/bin/node', script: '/h/runner.cjs', path: '/usr/bin:/bin' })
    expect(unit).toContain('ExecStart="/usr/bin/node" "/h/runner.cjs" runner run')
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"')
    expect(wrapperText("/o'k/node", '/h/r.cjs')).toBe(`#!/bin/sh\nexec '/o'\\''k/node' '/h/r.cjs' runner "$@"\n`)
  })
})

describe('安装、配置、停用（假的命令和云端）', () => {
  let home: string
  let calls: string[]
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args].join(' '))
    if (args.includes('show-user')) return { ok: true, stdout: 'Linger=no\n', stderr: '' }
    return { ok: true, stdout: '', stderr: '' }
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pixelsky-runner-'))
    calls = []
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://cloud.test/v1/teams/runners/pair')
        expect(JSON.parse(String(init.body))).toMatchObject({ code: 'C0DE' })
        return new Response(JSON.stringify({ runner_id: 'rn_1', name: 'build-box', token: 'rn_secret' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
  })

  it('装好：拷 helper、配对存令牌、写单元、启服务、试着开 linger；linger 没开成照实返回', async () => {
    const paths = runnerPaths(home)
    const helper = join(home, 'helper.cjs')
    writeFileSync(helper, '// helper')
    const result = await install(
      paths,
      { code: 'C0DE', base: 'https://cloud.test', helper, node: '/usr/bin/node', path: '/usr/bin', user: 'lin' },
      exec,
    )
    expect(result).toEqual({ runnerId: 'rn_1', linger: false })
    expect(readFileSync(paths.script, 'utf8')).toBe('// helper')
    expect(readAccount(paths.dir)).toMatchObject({ runnerId: 'rn_1', token: 'rn_secret', base: 'https://cloud.test' })
    expect(readFileSync(paths.unit, 'utf8')).toContain('runner run')
    expect(calls).toContain('systemctl --user restart pixelsky-runner.service')
    expect(calls).toContain('loginctl enable-linger lin')
    const s = await state(paths, 'lin', exec)
    expect(s).toMatchObject({ installed: true, runnerId: 'rn_1', linger: false })

    // 只认装它的那台桌面推的配置
    const config = { format: 1, installer: 'dev-A', teammate, members: [] }
    configure(paths, config)
    expect(() => configure(paths, { ...config, installer: 'dev-B' })).toThrow('另一台电脑装的')
    expect(() => configure(paths, { format: 9 })).toThrow('配置不对')

    // 重新安装（换了一台桌面）：旧配置清掉、服务重启，新桌面推的配置认得
    calls = []
    await install(
      paths,
      { code: 'C0DE', base: 'https://cloud.test', helper, node: '/usr/bin/node', path: '/usr/bin', user: 'lin' },
      exec,
    )
    expect(existsSync(join(paths.dir, 'config.json'))).toBe(false)
    expect(calls).toContain('systemctl --user restart pixelsky-runner.service')
    configure(paths, { ...config, installer: 'dev-B' })

    await remove(paths, exec)
    expect(existsSync(paths.unit)).toBe(false)
    expect(readAccount(paths.dir)).toBeNull()
    expect(calls).toContain('systemctl --user disable --now pixelsky-runner.service')
  })

  it('没有 systemd 用户服务：不装，报原因', async () => {
    const paths = runnerPaths(home)
    const noSystemd: Exec = async () => ({ ok: false, stdout: '', stderr: 'Failed to connect to bus' })
    await expect(
      install(
        paths,
        { code: 'C', base: 'https://cloud.test', helper: '/x', node: 'n', path: '', user: 'u' },
        noSystemd,
      ),
    ).rejects.toThrow('systemd')
    expect(existsSync(paths.script)).toBe(false)
  })
})

describe('执行机的请求', () => {
  afterEach(() => vi.unstubAllGlobals())
  const account = { base: 'https://cloud.test', runnerId: 'rn_1', name: 'box', token: 'rn_secret' }

  it('只调团队接口，带执行机令牌；运行凭证只用在 runs/ 接口', async () => {
    const seen: { url: string; auth: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, auth: (init.headers as Record<string, string>).Authorization })
        return new Response('{}')
      }),
    )
    const f = runnerFetch(account)
    await f('GET', '/v1/teams')
    await f('POST', '/v1/teams/t1/runs/r1/finish', {}, undefined, 'rt_run')
    expect(seen).toEqual([
      { url: 'https://cloud.test/v1/teams', auth: 'Bearer rn_secret' },
      { url: 'https://cloud.test/v1/teams/t1/runs/r1/finish', auth: 'Bearer rt_run' },
    ])
    await expect(f('GET', '/v1/inbox')).rejects.toThrow('无效的团队接口')
    await expect(f('GET', '/v1/teams/../account')).rejects.toThrow('无效的团队接口')
    await expect(f('GET', '/v1/teams/t1/tasks', undefined, undefined, 'rt_run')).rejects.toThrow('无效的团队接口')
    await expect(f('GET', '/v1/teams/t1/runs/x', undefined, undefined, 'rn_secret')).rejects.toThrow('无效的团队接口')
  })
})
