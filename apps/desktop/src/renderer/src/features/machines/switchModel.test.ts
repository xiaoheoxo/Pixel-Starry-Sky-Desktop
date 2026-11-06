import { describe, expect, it } from 'vitest'
import type { CheckItem, MachineInfo, MachineState } from '../../../../shared/types/machines'
import { cloudMachines, switchView, wslMachines, wslStatusLine } from './switchModel'

const machine = (id: string, status: MachineInfo['status'], name = id): MachineInfo => ({
  id,
  kind: id === 'local' ? 'local' : id.startsWith('wsl-') ? 'wsl' : 'ssh',
  name,
  host: id === 'local' ? '' : 'h',
  port: 22,
  username: 'u',
  auth: id === 'local' ? 'local' : 'agent',
  hasSecret: false,
  status,
  error: null,
  fingerprint: null,
  platform: null,
  home: null,
})
const local = machine('local', 'local')
const state = (currentId: string, ...others: MachineInfo[]): MachineState => ({
  currentId,
  machines: [local, ...others],
})

describe('switchView', () => {
  it('当前是本机', () => {
    expect(switchView(state('local', machine('ssh-1', 'connected')))).toEqual({ side: 'local', warn: false })
  })
  it('远程已连接', () => {
    expect(switchView(state('ssh-1', machine('ssh-1', 'connected', 'dev-server')))).toEqual({
      side: 'cloud',
      name: 'dev-server',
      warn: false,
    })
  })
  it.each(['disconnected', 'error', 'connecting'] as const)('远程 %s 时带警告点', status => {
    expect(switchView(state('ssh-1', machine('ssh-1', status, 'gpu-box')))).toEqual({
      side: 'cloud',
      name: 'gpu-box',
      warn: true,
    })
  })
  it('没有远程机器', () => {
    expect(switchView(state('local'))).toEqual({ side: 'local', warn: false })
  })
  it('当前是 WSL 发行版：本机这一边，带发行版名', () => {
    expect(switchView(state('wsl-aaaaaaaaaaaa', machine('wsl-aaaaaaaaaaaa', 'connected', 'Ubuntu')))).toEqual({
      side: 'local',
      name: 'Ubuntu',
      warn: false,
    })
  })
  it('WSL 发行版：云端那半不带名字（view.side 为 local）', () => {
    const v = switchView(state('wsl-aaaaaaaaaaaa', machine('wsl-aaaaaaaaaaaa', 'connected', 'Ubuntu-24.04')))
    expect(v.side).toBe('local')
  })
  it('WSL 发行版没连上时带警告点', () => {
    expect(switchView(state('wsl-aaaaaaaaaaaa', machine('wsl-aaaaaaaaaaaa', 'error', 'Debian'))).warn).toBe(true)
  })
  it('当前机器不在列表里时当本机', () => {
    expect(switchView(state('ssh-9')).side).toBe('local')
  })
})

describe('cloudMachines', () => {
  it('不含本机', () => {
    const a = machine('ssh-1', 'connected'),
      b = machine('ssh-2', 'disconnected')
    expect(cloudMachines(state('local', a, b))).toEqual([a, b])
    expect(cloudMachines(state('local'))).toEqual([])
  })
  it('不含 WSL 发行版', () => {
    const a = machine('ssh-1', 'connected')
    expect(cloudMachines(state('local', a, machine('wsl-bbbbbbbbbbbb', 'disconnected')))).toEqual([a])
  })
})

const item = (key: CheckItem['key'], status: CheckItem['status'], required: boolean, extra: Partial<CheckItem> = {}) =>
  ({ key, status, required, detail: '', ...extra }) as CheckItem
const distro = (
  status: MachineInfo['status'],
  wslState: 'running' | 'stopped',
  items?: CheckItem[],
  error: string | null = null,
): MachineInfo => ({
  ...machine('wsl-aaaaaaaaaaaa', status, 'Debian'),
  error,
  wsl: { distro: 'Debian', version: 2, isDefault: false, state: wslState, lastCheck: items && { at: 1, items } },
})
const passing = [
  item('start', 'ok', true),
  item('node', 'ok', true),
  item('claude', 'ok', false, { detail: '2.1.299' }),
]
const nodeOld = [item('start', 'ok', true), item('node', 'fail', true, { code: 'NODE_OLD' })]

describe('wslMachines', () => {
  it('只取 WSL 发行版', () => {
    const w = machine('wsl-bbbbbbbbbbbb', 'disconnected')
    expect(wslMachines(state('local', machine('ssh-1', 'connected'), w))).toEqual([w])
  })
})

describe('wslStatusLine', () => {
  it('已连接，带 Claude Code 版本', () => {
    expect(wslStatusLine(distro('connected', 'running', passing))).toEqual({
      tone: 'ok',
      key: 'wsl.status.connectedVersion',
      params: { version: 'Claude Code 2.1' },
      needsPrep: false,
    })
  })
  it('已连接：Codex 和自带的 Pixel 引擎能用也列出来；路径里的数字不当版本', () => {
    const items = [
      ...passing,
      item('codex', 'ok', false, { detail: 'codex-cli 0.163.0 (/usr/local/bin/codex)' }),
      item('pixel', 'ok', false, { detail: 'node 22.19.0' }),
    ]
    expect(wslStatusLine(distro('connected', 'running', items)).params).toEqual({
      version: 'Claude Code 2.1 · Codex 0.163 · Pixel',
    })
    const noVersion = [
      item('start', 'ok', true),
      item('claude', 'ok', false, { detail: 'installed (/home/u/.nvm/versions/node/v22.19.0/bin/claude)' }),
      item('pixel', 'warn', false, { code: 'PIXEL_NODE_OLD' }),
    ]
    expect(wslStatusLine(distro('connected', 'running', noVersion)).params).toEqual({ version: 'Claude Code' })
  })
  it('已连接，没有版本', () => {
    expect(wslStatusLine(distro('connected', 'running'))).toEqual({
      tone: 'ok',
      key: 'wsl.status.connected',
      needsPrep: false,
    })
  })
  it('连接中', () => {
    expect(wslStatusLine(distro('connecting', 'running')).tone).toBe('busy')
  })
  it('运行中且上次检查通过', () => {
    expect(wslStatusLine(distro('disconnected', 'running', passing))).toEqual({
      tone: 'ok',
      key: 'wsl.status.runningOk',
      needsPrep: false,
    })
  })
  it('没运行，上次检查有必需项没过：需要准备', () => {
    expect(wslStatusLine(distro('disconnected', 'stopped', nodeOld))).toEqual({
      tone: 'idle',
      key: 'wsl.status.stoppedFailed',
      params: { problem: 'wsl.problem.NODE_OLD' },
      needsPrep: true,
    })
  })
  it('运行中，上次检查没过', () => {
    const line = wslStatusLine(distro('disconnected', 'running', nodeOld))
    expect(line.key).toBe('wsl.status.runningFailed')
    expect(line.needsPrep).toBe(true)
  })
  it('可选项没过不算需要准备', () => {
    const items = [...passing, item('codex', 'warn', false, { code: 'CODEX_MISSING' })]
    expect(wslStatusLine(distro('disconnected', 'stopped', items)).needsPrep).toBe(false)
  })
  it('没有检查记录', () => {
    expect(wslStatusLine(distro('disconnected', 'stopped')).key).toBe('wsl.status.stoppedNever')
    expect(wslStatusLine(distro('disconnected', 'running')).key).toBe('wsl.status.runningNever')
  })
  it('出错：显示错误码；WSL_NOT_READY 走检查记录', () => {
    expect(wslStatusLine(distro('error', 'running', undefined, 'WSL_START_FAILED'))).toEqual({
      tone: 'warn',
      key: 'wsl.status.error',
      params: { code: 'WSL_START_FAILED' },
      needsPrep: false,
    })
    expect(wslStatusLine(distro('error', 'stopped', nodeOld, 'WSL_NOT_READY')).needsPrep).toBe(true)
  })
})
