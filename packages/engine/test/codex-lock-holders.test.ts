import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lockFileState, lockHolderReport, parsePsList, parseWindowsList } from '../src/codex/lock-holders'
import { makeTmp, removeTmp } from './helpers/tmp'

let root: string
beforeEach(() => {
  root = makeTmp('codex-lock-holders')
})
afterEach(() => removeTmp(root))

describe('线程被占着时查是谁（docs/ui/codex-resume.md §13.2）', () => {
  it('Windows 的进程列表：一个进程时 PowerShell 给对象，没有时是空', () => {
    expect(parseWindowsList('')).toEqual([])
    expect(
      parseWindowsList(
        '{"pid":12,"ppid":3,"parent":null,"started":"2026-11-19T20:00:00","command":"codex.exe app-server"}',
      ),
    ).toEqual([{ pid: 12, ppid: 3, parent: null, started: '2026-11-19T20:00:00', command: 'codex.exe app-server' }])
    expect(
      parseWindowsList('[{"pid":1,"ppid":2,"parent":"node.exe","started":"","command":"c"},{"x":1}]'),
    ).toHaveLength(1)
  })

  it('ps 输出：只留程序名是 codex 的，父进程名从同一份列表里找，找不到是 null', () => {
    const text = [
      '  100     1    01:02:03 /usr/bin/zsh -l',
      '  200   100       05:00 /opt/codex/bin/codex resume abc',
      '  300  9999       00:10 codex app-server --listen stdio://',
      '  400   100       00:10 node /x/codex-helper.js',
    ].join('\n')
    expect(parsePsList(text)).toEqual([
      { pid: 200, ppid: 100, started: '05:00', command: '/opt/codex/bin/codex resume abc', parent: 'zsh' },
      { pid: 300, ppid: 9999, started: '00:10', command: 'codex app-server --listen stdio://', parent: null },
    ])
  })

  it('报告：锁文件状态、父进程已退出、命令行里有线程 id、父进程是本应用、命令行脱敏；查列表失败只记原因', async () => {
    const home = join(root, 'home')
    expect(lockFileState(home, 't1')).toBe('none')
    mkdirSync(join(home, 'thread-writer-locks'), { recursive: true })
    writeFileSync(join(home, 'thread-writer-locks', 't1.lock'), '')
    // 没人占着：Windows 读得出来是 free（占着时读报 EBUSY，真 Codex 实测），其它系统只知道在
    expect(lockFileState(home, 't1')).toBe(process.platform === 'win32' ? 'free' : 'exists')
    const report = await lockHolderReport(home, 't1', async () => [
      {
        pid: 7,
        ppid: 8,
        parent: null,
        started: 's',
        command: 'codex resume t1 OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx',
      },
      { pid: 9, ppid: process.pid, parent: 'electron', started: 's', command: 'codex app-server' },
    ])
    const [orphan, child] = report.processes as Record<string, unknown>[]
    expect(orphan).toMatchObject({ pid: 7, parent: '(已退出)', mentionsThread: true })
    expect(String(orphan.command)).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(child).toMatchObject({ pid: 9, parentIsApp: true })
    expect(child.mentionsThread).toBeUndefined()
    const failed = await lockHolderReport(home, 't1', async () => {
      throw new Error('powershell 不在\n第二行')
    })
    expect(failed.listError).toBe('powershell 不在')
  })
})
