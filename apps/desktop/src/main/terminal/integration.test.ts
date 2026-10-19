import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BASH_SCRIPT,
  integrationKind,
  POWERSHELL_SCRIPT,
  shellIntegration,
  writeIntegrationFiles,
  ZSH_FILES,
} from './integration'

const profile = (command: string, args: string[], custom?: boolean) => ({ command, args, custom })

describe('哪些 shell 注入', () => {
  it('内置的 PowerShell / cmd / bash / zsh 注入，自定义、fish、sh 不注入', () => {
    expect(integrationKind(profile('C:\\Program Files\\PowerShell\\7\\pwsh.exe', ['-NoLogo']))).toBe('powershell')
    expect(integrationKind(profile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', []))).toBe(
      'powershell',
    )
    expect(integrationKind(profile('C:\\Windows\\System32\\cmd.exe', ['/d']))).toBe('cmd')
    expect(integrationKind(profile('C:\\Program Files\\Git\\bin\\bash.exe', ['--login', '-i']))).toBe('bash')
    expect(integrationKind(profile('/bin/zsh', ['-l']))).toBe('zsh')
    expect(integrationKind(profile('/usr/bin/fish', ['-l']))).toBeNull()
    expect(integrationKind(profile('/bin/sh', []))).toBeNull()
    expect(integrationKind(profile('pwsh.exe', ['-NoProfile', '-Command', 'x'], true))).toBeNull()
  })
})

describe('PowerShell 注入', () => {
  const result = shellIntegration(profile('pwsh.exe', ['-NoLogo']), null, {}, 'win32')!

  it('在原参数后面加 -NoExit -EncodedCommand（不带 -NoProfile：用户 profile 照常加载）', () => {
    expect(result.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand'])
    expect(result.args).not.toContain('-NoProfile')
    expect(result.env).toEqual({})
    expect(result.exitCodes).toBe(true)
  })

  it('命令文本是 UTF-16LE 的 base64，解出来就是脚本（不用脚本文件，躲开执行策略）', () => {
    expect(Buffer.from(result.args[3], 'base64').toString('utf16le')).toBe(POWERSHELL_SCRIPT)
  })

  it('脚本包 prompt：先存 $?、只在命令真跑过才发 D、不改 $LASTEXITCODE', () => {
    expect(POWERSHELL_SCRIPT).toContain('function global:prompt')
    expect(POWERSHELL_SCRIPT.indexOf('$ok = $?')).toBeLessThan(POWERSHELL_SCRIPT.indexOf('Get-History'))
    expect(POWERSHELL_SCRIPT).toContain(']633;D;')
    expect(POWERSHELL_SCRIPT).toContain(']633;A')
    // 被 Ctrl+C 中止的命令（历史记录 Stopped）记 130，不记成失败的 1
    expect(POWERSHELL_SCRIPT).toContain("ExecutionStatus -eq 'Stopped'")
    expect(POWERSHELL_SCRIPT).toContain("Write-Error 'failure' -ErrorAction Ignore")
    expect(POWERSHELL_SCRIPT).not.toMatch(/\$(global:)?LASTEXITCODE\s*=[^=]/)
  })
})

describe('cmd 注入', () => {
  it('PROMPT 前面加一个 BEL 结尾的提示符开始标记，保留用户原来的 PROMPT', () => {
    const plain = shellIntegration(profile('cmd.exe', ['/d']), null, {}, 'win32')!
    expect(plain.env.PROMPT).toBe('$E]633;A\u0007$P$G')
    expect(plain.args).toEqual(['/d'])
    expect(plain.exitCodes).toBe(false)
    const custom = shellIntegration(profile('cmd.exe', ['/d']), null, { Prompt: '$T$G' }, 'win32')!
    expect(custom.env.PROMPT).toBe('$E]633;A\u0007$T$G')
  })

  it('已经带标记的（嵌套 cmd）不重复加', () => {
    const nested = '\u001b]633;A\u0007$P$G'
    expect(shellIntegration(profile('cmd.exe', ['/d']), null, { PROMPT: nested }, 'win32')!.env.PROMPT).toBe(nested)
  })
})

describe('bash 注入', () => {
  it('Git Bash：--login 换成 --init-file，登录由脚本模仿，环境变量带上标记', () => {
    const result = shellIntegration(
      profile('C:\\Program Files\\Git\\bin\\bash.exe', ['--login', '-i']),
      'C:\\Users\\me\\AppData\\Roaming\\PixelSky\\terminal\\integration',
      {},
      'win32',
    )!
    expect(result.args).toEqual([
      '--init-file',
      'C:/Users/me/AppData/Roaming/PixelSky/terminal/integration/bash.sh',
      '-i',
    ])
    expect(result.env).toEqual({ PIXELSKY_SHELL_LOGIN: '1' })
    expect(result.exitCodes).toBe(true)
  })

  it('macOS / Linux 的 bash -l 同样处理；没有脚本目录就不注入', () => {
    const result = shellIntegration(profile('/bin/bash', ['-l']), '/data/integration', {}, 'darwin')!
    expect(result.args).toEqual(['--init-file', '/data/integration/bash.sh', '-i'])
    expect(shellIntegration(profile('/bin/bash', ['-l']), null, {}, 'darwin')).toBeNull()
  })

  it('脚本：先读用户的启动文件，再把钩子放到 PROMPT_COMMAND 最前面，并保住 $?', () => {
    expect(BASH_SCRIPT).toContain('/etc/profile')
    expect(BASH_SCRIPT).toContain('~/.bash_profile ~/.bash_login ~/.profile')
    expect(BASH_SCRIPT).toContain('~/.bashrc')
    expect(BASH_SCRIPT).toContain('local ec=$?')
    expect(BASH_SCRIPT).toContain('return $ec')
    expect(BASH_SCRIPT).toContain('PROMPT_COMMAND="__pixelsky_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"')
    // 第一个提示符之前没跑过命令，不发 D
    expect(BASH_SCRIPT).toContain('if [ -n "$__pixelsky_seen" ]')
    expect(BASH_SCRIPT).not.toContain('\r')
  })
})

describe('zsh 注入', () => {
  it('ZDOTDIR 指向我们的目录，记下用户原来的', () => {
    const result = shellIntegration(profile('/bin/zsh', ['-l']), '/data/integration', { HOME: '/Users/me' }, 'darwin')!
    expect(result.args).toEqual(['-l'])
    expect(result.env).toEqual({
      ZDOTDIR: '/data/integration/zsh',
      PIXELSKY_ZDOTDIR: '/data/integration/zsh',
      PIXELSKY_USER_ZDOTDIR: '/Users/me',
      PIXELSKY_ORIG_ZDOTDIR: '',
    })
    const custom = shellIntegration(
      profile('/bin/zsh', ['-l']),
      '/data/integration',
      { HOME: '/Users/me', ZDOTDIR: '/Users/me/.config/zsh' },
      'darwin',
    )!
    expect(custom.env.PIXELSKY_USER_ZDOTDIR).toBe('/Users/me/.config/zsh')
    expect(custom.env.PIXELSKY_ORIG_ZDOTDIR).toBe('/Users/me/.config/zsh')
  })

  it('每个启动文件先读用户自己的同名文件；.zshrc 末尾装钩子并还原 ZDOTDIR', () => {
    for (const name of ['.zshenv', '.zprofile', '.zshrc']) expect(ZSH_FILES[name]).toContain(`/${name}`)
    const rc = ZSH_FILES['.zshrc']
    expect(rc).toContain('precmd_functions=(__pixelsky_precmd')
    expect(rc).toContain('local ec=$?')
    // 还原成用户启动文件跑完后的值（XDG 写法 ~/.zshenv 里 export ZDOTDIR=~/.config/zsh 也对）；只有仍是 $HOME 且原来没设才 unset
    expect(rc).toContain('ZDOTDIR="$PIXELSKY_USER_ZDOTDIR"; fi')
    expect(rc).toContain('[[ "$PIXELSKY_USER_ZDOTDIR" == "$HOME" && -z "$PIXELSKY_ORIG_ZDOTDIR" ]]; then unset ZDOTDIR')
    expect(rc).not.toContain('ZDOTDIR="$PIXELSKY_ORIG_ZDOTDIR"')
    expect(rc.indexOf('. "$PIXELSKY_USER_ZDOTDIR/.zshrc"')).toBeLessThan(rc.indexOf('precmd_functions='))
  })
})

describe('写脚本文件', () => {
  it('bash.sh 和 zsh/ 下的三个文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pixelsky-integration-'))
    try {
      await writeIntegrationFiles(dir)
      expect(await readFile(join(dir, 'bash.sh'), 'utf8')).toBe(BASH_SCRIPT)
      expect((await readdir(join(dir, 'zsh'))).sort()).toEqual(['.zprofile', '.zshenv', '.zshrc'])
      expect(await readFile(join(dir, 'zsh', '.zshrc'), 'utf8')).toBe(ZSH_FILES['.zshrc'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
