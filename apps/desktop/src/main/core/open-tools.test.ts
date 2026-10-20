// 「打开方式」里的 JetBrains IDE 和文件夹 / 终端程序（GitHub #12）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EDITORS, editorArgs, posixEditorPaths } from './editors'
import {
  detectJetBrains,
  detectTools,
  jetbrainsName,
  linuxTerminalArgs,
  toolboxInstallLocation,
  toolCommand,
  launchOptions,
} from './open-tools'

/** 临时目录里放几个假的程序，快捷方式指着它们 */
function installed(...paths: string[]): { root: string; at: (path: string) => string } {
  const root = mkdtempSync(join(tmpdir(), 'open-tools-'))
  for (const path of paths) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), '')
  }
  return { root, at: path => join(root, path) }
}

describe('JetBrains IDE', () => {
  it.runIf(process.platform === 'win32')(
    '从快捷方式认出来：名字和版本按快捷方式名，别的程序不算，排在其他来源前面',
    async () => {
      const dir = installed('IDEA\\bin\\idea64.exe', 'PyCharm CE\\bin\\pycharm64.exe', 'Other\\bin\\helper.exe')
      try {
        const found = await detectJetBrains([
          { name: 'IntelliJ IDEA 2026.2.1', target: dir.at('IDEA\\bin\\idea64.exe') },
          { name: 'PyCharm Community Edition 2025.3', target: dir.at('PyCharm CE\\bin\\pycharm64.exe') },
          { name: 'IntelliJ IDEA helper', target: dir.at('Other\\bin\\helper.exe') },
        ])
        const ours = found.filter(f => f.path.startsWith(dir.root))
        expect(ours).toEqual([
          { path: dir.at('IDEA\\bin\\idea64.exe'), name: 'IntelliJ IDEA', version: '2026.2.1', source: 'shortcut' },
          { path: dir.at('PyCharm CE\\bin\\pycharm64.exe'), name: 'PyCharm', version: '2025.3', source: 'shortcut' },
        ])
        expect(found.indexOf(ours[0])).toBe(0)
      } finally {
        rmSync(dir.root, { recursive: true, force: true })
      }
    },
  )

  it('Toolbox 设置里的安装目录：有就返回，没有、空的、文件坏了都是 null（GitHub #30）', async () => {
    const dir = installed()
    try {
      const file = join(dir.root, '.settings.json')
      writeFileSync(file, JSON.stringify({ install_location: ' D:\\JB ', update: {} }))
      expect(await toolboxInstallLocation(file)).toBe('D:\\JB')
      writeFileSync(file, JSON.stringify({ install_location: '' }))
      expect(await toolboxInstallLocation(file)).toBeNull()
      writeFileSync(file, '{坏了')
      expect(await toolboxInstallLocation(file)).toBeNull()
      expect(await toolboxInstallLocation(join(dir.root, 'none.json'))).toBeNull()
    } finally {
      rmSync(dir.root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')(
    'Toolbox 改过安装目录：新版 <目录>\\<IDE>\\bin 和旧版 apps\\<产品>\\ch-0\\<版本>\\bin 都找得到（GitHub #30）',
    async () => {
      const dir = installed(
        'local\\JetBrains\\Toolbox\\.settings.json',
        'tools\\IntelliJ IDEA Ultimate\\bin\\idea64.exe',
        'tools\\apps\\PyCharm-P\\ch-0\\253.1\\bin\\pycharm64.exe',
      )
      writeFileSync(
        dir.at('local\\JetBrains\\Toolbox\\.settings.json'),
        JSON.stringify({ install_location: dir.at('tools') }),
      )
      const local = process.env.LOCALAPPDATA
      process.env.LOCALAPPDATA = dir.at('local')
      try {
        const found = (await detectJetBrains()).filter(f => f.path.startsWith(dir.root))
        expect(found.map(f => [f.name, f.source])).toEqual([
          ['IntelliJ IDEA', 'location'],
          ['PyCharm', 'location'],
        ])
      } finally {
        process.env.LOCALAPPDATA = local
        rmSync(dir.root, { recursive: true, force: true })
      }
    },
  )

  it.runIf(process.platform === 'win32')('Git Bash 先用快捷方式指着的那个', async () => {
    const dir = installed('Git\\git-bash.exe')
    try {
      const tools = await detectTools([{ name: 'Git Bash', target: dir.at('Git\\git-bash.exe') }])
      expect(tools.find(t => t.id === 'git-bash')?.path).toBe(dir.at('Git\\git-bash.exe'))
    } finally {
      rmSync(dir.root, { recursive: true, force: true })
    }
  })

  it('名字是产品名，版本从快捷方式名或安装目录名里取', () => {
    expect(jetbrainsName('D:\\JB\\IntelliJ IDEA 2026.2.1\\bin\\idea64.exe')).toEqual({
      name: 'IntelliJ IDEA',
      version: '2026.2.1',
    })
    expect(jetbrainsName('C:\\x\\bin\\pycharm64.exe', 'PyCharm Community Edition 2025.3')).toEqual({
      name: 'PyCharm',
      version: '2025.3',
    })
    expect(jetbrainsName('C:\\Users\\me\\AppData\\Local\\Programs\\WebStorm\\bin\\webstorm64.exe')).toEqual({
      name: 'WebStorm',
      version: undefined,
    })
  })

  it('打开参数：工作区；文件带 --line / --column，项目目录在前', () => {
    expect(editorArgs('jetbrains', 'reuse', 'D:\\proj')).toEqual(['D:\\proj'])
    expect(editorArgs('jetbrains', 'reuse', 'D:\\proj', 'D:\\proj\\a.ts', 12, 3)).toEqual([
      'D:\\proj',
      '--line',
      '12',
      '--column',
      '3',
      'D:\\proj\\a.ts',
    ])
    expect(editorArgs('jetbrains', 'new', 'D:\\proj', 'D:\\proj\\a.ts')).toEqual(['D:\\proj', 'D:\\proj\\a.ts'])
    expect(() => editorArgs('jetbrains', 'reuse', 'D:\\proj', 'D:\\proj\\a.ts', 0)).toThrow('行列')
  })
})

describe('文件夹和终端', () => {
  const tool = (id: 'git-bash' | 'windows-terminal' | 'pwsh' | 'powershell', path = `C:\\${id}.exe`) => ({
    id,
    name: id,
    path,
  })
  it('各自按自己的参数停在工作区目录', () => {
    expect(toolCommand(tool('git-bash'), 'D:\\my proj')).toEqual({
      file: 'C:\\git-bash.exe',
      args: ['--cd=D:\\my proj'],
      console: false,
    })
    expect(toolCommand(tool('windows-terminal'), 'D:\\p').args).toEqual(['-d', 'D:\\p'])
    expect(toolCommand(tool('pwsh'), 'D:\\p')).toMatchObject({
      args: ['-NoExit', '-WorkingDirectory', 'D:\\p'],
      console: true,
    })
    expect(toolCommand(tool('powershell'), 'D:\\p')).toMatchObject({ args: ['-NoExit'], console: true })
  })
})

describe('macOS / Linux', () => {
  it('JetBrains 认 macOS / Linux 的启动程序名', () => {
    expect(jetbrainsName('/Applications/IntelliJ IDEA.app/Contents/MacOS/idea', 'IntelliJ IDEA 2026.2').name).toBe(
      'IntelliJ IDEA',
    )
    expect(jetbrainsName('/opt/pycharm-2025.3/bin/pycharm.sh').name).toBe('PyCharm')
    expect(jetbrainsName('/home/me/.local/share/JetBrains/Toolbox/scripts/webstorm').name).toBe('WebStorm')
  })

  it('VS Code 一类找自带的命令行：macOS 在 .app 里，Linux 在 /usr/share、snap，再是 PATH', () => {
    const vscode = EDITORS[0]
    expect(posixEditorPaths(vscode, 'darwin', '/Users/me', ['/opt/homebrew/bin']).map(c => c.path)).toEqual([
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/Users/me/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      '/opt/homebrew/bin/code',
    ])
    expect(posixEditorPaths(vscode, 'linux', '/home/me', []).map(c => c.path)).toContain('/usr/share/code/bin/code')
  })

  it('Linux 终端按各自的参数停在工作区目录', () => {
    expect(linuxTerminalArgs('/usr/bin/gnome-terminal', '/p')).toEqual(['--working-directory=/p'])
    expect(linuxTerminalArgs('/usr/bin/konsole', '/p')).toEqual(['--workdir', '/p'])
    expect(linuxTerminalArgs('/usr/bin/x-terminal-emulator', '/p')).toEqual([])
  })
})

describe('launching folder and terminal tools', () => {
  it('never hides the window (Explorer opened invisibly with windowsHide)', () => {
    const opts = launchOptions('/work/p', {})
    expect(opts.windowsHide).toBe(false)
    expect(opts).toMatchObject({ cwd: '/work/p', shell: false, detached: true, stdio: 'ignore' })
  })
})
