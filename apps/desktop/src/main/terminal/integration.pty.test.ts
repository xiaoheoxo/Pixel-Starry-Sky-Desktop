// 真起 PowerShell 的集成测试（只在 Windows 上跑，需要装了 pwsh / powershell）：
// 验证提示符标记真的能穿过 ConPTY，且任务面板最关心的那件事成立 ——
// Ctrl+C 中止「命令 + exit 后缀」整行后，shell 留在提示符，但我们仍然收到「命令结束」标记。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { POWERSHELL_SCRIPT, shellIntegration, writeIntegrationFiles } from './integration'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TerminalManager } from './manager'
import type { TerminalEvent } from '../../shared/types/terminal'
import { createMarkParser, type ShellMark } from './shellMarks'
import { powerShell7, terminalEnvironment } from './profiles'

const windowsPowerShell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const IS_WINDOWS = process.platform === 'win32'
// 没装 PowerShell 7 的机器上 pwsh 的用例跳过，不报错
const PWSH = IS_WINDOWS ? await powerShell7() : null
const SHELLS = [
  ...(PWSH ? [{ name: 'pwsh', command: PWSH }] : []),
  ...(IS_WINDOWS && existsSync(windowsPowerShell) ? [{ name: 'Windows PowerShell', command: windowsPowerShell }] : []),
]

// 真起 shell 慢，机器忙（整个套件并行跑）时更慢
vi.setConfig({ testTimeout: 60_000 })

// 任务面板写进终端的后缀（和 renderer 的 exitSuffix 一致）
const SUFFIX = '; $ok=$?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 }; exit 0'

class Session {
  child: pty.IPty
  marks: ShellMark[] = []
  text = ''
  exited: number | null = null
  private parser = createMarkParser()
  constructor(
    command: string,
    args: string[] = ['-NoLogo', '-NoProfile'],
    options: { dir?: string; pre?: string } = {},
  ) {
    // Claude Code 的 shell 会设 NoDefaultCurrentDirectoryInExePath，这里不让它影响被测的 shell
    const env = terminalEnvironment({ ...process.env, NoDefaultCurrentDirectoryInExePath: undefined })
    const integration = shellIntegration({ command, args }, options.dir ?? null, env)!
    // pre：先于集成脚本执行的 PowerShell 命令（模拟用户 profile 里自定义的 prompt）
    if (options.pre)
      integration.args[integration.args.length - 1] = Buffer.from(options.pre + POWERSHELL_SCRIPT, 'utf16le').toString(
        'base64',
      )
    Object.assign(env, integration.env)
    this.child = pty.spawn(command, integration.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env,
      useConpty: true,
    })
    this.child.onData(data => {
      const parsed = this.parser.push(data)
      this.marks.push(...parsed.marks)
      this.text += parsed.text
    })
    this.child.onExit(({ exitCode }) => {
      this.exited = exitCode
    })
  }
  async until(check: () => boolean, label: string, ms = 20000): Promise<void> {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end)
        throw new Error(
          `等不到：${label}\n标记：${JSON.stringify(this.marks)}\n输出：${JSON.stringify(this.text.slice(-500))}`,
        )
      await new Promise(r => setTimeout(r, 40))
    }
  }
  close(): void {
    if (this.exited !== null) return
    try {
      this.child.kill()
    } catch {
      /* 已经退出 */
    }
  }
}

describe.skipIf(SHELLS.length === 0)('PowerShell 提示符标记（真实 ConPTY）', () => {
  let session: Session | undefined
  afterEach(() => session?.close())

  for (const shell of SHELLS) {
    describe(shell.name, () => {
      it('第一个提示符只有「提示符开始」，没有命令结束；标记不出现在文本里', async () => {
        session = new Session(shell.command)
        await session.until(() => session!.marks.length > 0, '第一个提示符')
        expect(session.marks).toEqual([{ kind: 'prompt' }])
        await session.until(() => /PS [^\r\n]*> /.test(session!.text), '原来的提示符')
        expect(session.text).not.toContain('633')
      })

      it('命令结束带退出码：成功 0、原生程序失败取它的退出码、cmdlet 出错记 1', async () => {
        session = new Session(shell.command)
        await session.until(() => session!.marks.length > 0, '第一个提示符')
        const run = async (line: string): Promise<ShellMark[]> => {
          const from = session!.marks.length
          session!.child.write(line + '\r')
          await session!.until(() => session!.marks.length >= from + 2, `「${line}」的结束标记`)
          return session!.marks.slice(from, from + 2)
        }
        expect(await run("Write-Output 'ok'")).toEqual([{ kind: 'end', exitCode: 0 }, { kind: 'prompt' }])
        expect(await run('cmd /c exit 3')).toEqual([{ kind: 'end', exitCode: 3 }, { kind: 'prompt' }])
        expect(await run('Get-Item Z:\\no\\such\\path')).toEqual([{ kind: 'end', exitCode: 1 }, { kind: 'prompt' }])
      })

      it('不改 $LASTEXITCODE，也不改原来的提示符', async () => {
        session = new Session(shell.command)
        await session.until(() => session!.marks.length > 0, '第一个提示符')
        session.child.write('cmd /c exit 7\r')
        await session.until(() => session!.marks.length >= 3, '第二个提示符')
        session.child.write('"code=$LASTEXITCODE"\r')
        await session.until(() => session!.text.includes('code=7'), '$LASTEXITCODE 还是 7')
        expect(session.text).not.toContain('633')
      })

      it('Ctrl+C 中止整行（命令 + exit 后缀）：shell 不退出，但收到命令结束', async () => {
        session = new Session(shell.command)
        await session.until(() => session!.marks.length > 0, '第一个提示符')
        session.child.write('Start-Sleep -Seconds 60' + SUFFIX + '\r')
        await new Promise(r => setTimeout(r, 800))
        const before = session.marks.length
        session.child.write('\x03')
        await session.until(() => session!.marks.length >= before + 2, 'Ctrl+C 之后的命令结束 + 提示符')
        const [end, prompt] = session.marks.slice(before)
        // cmdlet 被 Ctrl+C 中止：历史记录是 Stopped，记 130（不是失败的 1）
        expect(end).toEqual({ kind: 'end', exitCode: 130 })
        expect(prompt).toEqual({ kind: 'prompt' })
        // 整行作废：exit 没执行，shell 还活着
        expect(session.exited).toBeNull()
      })

      it('在空提示符上 Ctrl+C 不算命令结束', async () => {
        session = new Session(shell.command)
        await session.until(() => session!.marks.length > 0, '第一个提示符')
        session.child.write('\x03')
        await new Promise(r => setTimeout(r, 1500))
        expect(session.marks.filter(m => m.kind === 'end')).toEqual([])
      })

      it('正常跑完：exit 后缀让 shell 退出（旧的判定仍然有效）', async () => {
        session = new Session(shell.command)
        await session.until(() => session!.marks.length > 0, '第一个提示符')
        session.child.write('cmd /c exit 5' + SUFFIX + '\r')
        await session.until(() => session!.exited !== null, 'shell 退出')
        expect(session.exited).toBe(5)
      })
    })
  }
})

describe.skipIf(SHELLS.length === 0)('用户自定义的 prompt', () => {
  let session: Session | undefined
  afterEach(() => session?.close())
  it('原来的 prompt 照常调用，看到的 $? 和 $LASTEXITCODE 没被我们改', async () => {
    session = new Session(SHELLS[0].command, ['-NoLogo', '-NoProfile'], {
      pre: 'function prompt { "CUSTOM[$?][$LASTEXITCODE]> " }\n',
    })
    await session.until(() => session!.text.includes('CUSTOM['), '自定义提示符')
    session.child.write('cmd /c exit 4\r')
    await session.until(() => session!.text.includes('CUSTOM[False][4]> '), '失败后 $? 为 False、$LASTEXITCODE 为 4')
    session.child.write("Write-Output 'fine'\r")
    await session.until(() => session!.text.includes('CUSTOM[True][4]> '), '成功后 $? 为 True、$LASTEXITCODE 仍是 4')
    expect(session.marks.filter(m => m.kind === 'end').map(m => (m as { exitCode: number }).exitCode)).toEqual([4, 0])
  })
})

describe.skipIf(process.platform !== 'win32')('cmd 提示符标记（真实 ConPTY）', () => {
  let session: Session | undefined
  afterEach(() => session?.close())
  it('每个提示符发一个「提示符开始」，原来的提示符不变', async () => {
    session = new Session('cmd.exe', ['/d'])
    await session.until(() => session!.marks.length >= 1, '第一个提示符')
    session.child.write('echo hello\r')
    await session.until(() => session!.marks.length >= 2, '第二个提示符')
    expect(session.marks).toEqual([{ kind: 'prompt' }, { kind: 'prompt' }])
    expect(session.text).not.toContain('633')
    expect(session.text).toMatch(/[A-Za-z]:\\[^\r\n]*>/)
  })
})

const GIT_BASH = [
  process.env.ProgramFiles,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
  'D:\\Program Files',
]
  .filter((v): v is string => !!v)
  .map(v => join(v, 'Git', 'bin', 'bash.exe'))
  .find(p => existsSync(p))

describe.skipIf(process.platform !== 'win32' || !GIT_BASH)(
  'Git Bash 提示符标记（真实 ConPTY，--init-file 模仿登录 shell）',
  () => {
    let session: Session | undefined
    let dir = ''
    afterEach(() => {
      session?.close()
      if (dir) rmSync(dir, { recursive: true, force: true })
    })
    it('第一个提示符没有命令结束；失败命令带退出码；Ctrl+C 之后 shell 还在', async () => {
      dir = mkdtempSync(join(tmpdir(), 'pixelsky-bash-'))
      await writeIntegrationFiles(dir)
      session = new Session(GIT_BASH!, ['--login', '-i'], { dir })
      await session.until(() => session!.marks.length >= 1, '第一个提示符', 40000)
      expect(session.marks[0]).toEqual({ kind: 'prompt' })
      session.child.write('(exit 3)\r')
      await session.until(() => session!.marks.length >= 3, '失败命令的结束标记')
      expect(session.marks.slice(1, 3)).toEqual([{ kind: 'end', exitCode: 3 }, { kind: 'prompt' }])
      session.child.write('sleep 60; exit $?\r')
      await new Promise(r => setTimeout(r, 1000))
      session.child.write('\x03')
      await session.until(() => session!.marks.length >= 5, 'Ctrl+C 之后的结束标记')
      expect(session.marks[3]).toEqual({ kind: 'end', exitCode: 130 })
      expect(session.exited).toBeNull()
      expect(session.text).not.toContain('633')
    })
  },
)

describe.skipIf(!PWSH)('经过 TerminalManager（真实 pwsh）', () => {
  it('管理器注入集成：prompt 事件带退出码，Ctrl+C 中止整行后终端仍是 running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixelsky-manager-'))
    const events: TerminalEvent[] = []
    const manager = new TerminalManager(
      dir,
      () => ({ projectId: 'p', projectName: 'p', cwd: dir }),
      (_owner, event) => events.push(event),
    )
    try {
      await manager.init()
      const created = await manager.create(1, { projectId: 'p' }, 'pwsh', 'req-1')
      expect(created.status).toBe('running')
      const prompts = (): Extract<TerminalEvent, { type: 'prompt' }>[] =>
        events.filter((e): e is Extract<TerminalEvent, { type: 'prompt' }> => e.type === 'prompt')
      const until = async (check: () => boolean, label: string): Promise<void> => {
        const end = Date.now() + 30000
        while (!check()) {
          if (Date.now() > end) throw new Error('等不到：' + label)
          await new Promise(r => setTimeout(r, 40))
        }
      }
      await until(() => prompts().length >= 1, '第一个提示符')
      expect(prompts()[0]).toMatchObject({ ran: false, exitCode: null })
      manager.write(1, created.id, created.generation, 'Start-Sleep -Seconds 60' + SUFFIX + '\r')
      await new Promise(r => setTimeout(r, 1000))
      manager.write(1, created.id, created.generation, '\x03')
      await until(() => prompts().length >= 2, 'Ctrl+C 之后的提示符')
      expect(prompts()[1]).toMatchObject({ ran: true })
      expect(manager.state(1).terminals[0].status).toBe('running')
      const shown = events.flatMap(e => (e.type === 'data' ? [e.data] : [])).join('')
      expect(shown).not.toContain('633')
    } finally {
      await manager.shutdown().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// 中文 Windows 默认 GBK：UTF-8 文件用 type 读出来会是「涓枃」。选 UTF-8 后应该原样显示
describe.skipIf(!SHELLS.length)('终端编码选 UTF-8：UTF-8 文件里的中文不乱码', () => {
  it.each(SHELLS)('$name', async ({ command }) => {
    // 临时目录放仓库根目录的 scratch/（AGENTS.md §2）
    const dir = mkdtempSync(fileURLToPath(new URL('../../../../../scratch/pty-utf8-', import.meta.url)))
    try {
      writeFileSync(join(dir, 'u8.txt'), '中文编码测试', 'utf8')
      const env = terminalEnvironment({ ...process.env, NoDefaultCurrentDirectoryInExePath: undefined })
      const integration = shellIntegration({ command, args: ['-NoLogo', '-NoProfile'] }, null, env, 'win32', true)!
      const child = pty.spawn(command, integration.args, { cols: 120, rows: 30, cwd: dir, env, useConpty: true })
      let text = ''
      child.onData(d => (text += d))
      const exited = new Promise<void>(r => child.onExit(() => r()))
      try {
        const end = Date.now() + 30000
        let sent = false
        while (!text.includes('中文编码测试')) {
          if (Date.now() > end) throw new Error('等不到中文：' + JSON.stringify(text.slice(-300)))
          if (!sent && text.includes(']633;A')) {
            child.write('cmd /c type u8.txt\r')
            sent = true
          }
          await new Promise(r => setTimeout(r, 100))
        }
      } finally {
        child.kill()
        // shell 的工作目录就是 dir：退出后才删得掉
        await Promise.race([exited, new Promise(r => setTimeout(r, 5000))])
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
