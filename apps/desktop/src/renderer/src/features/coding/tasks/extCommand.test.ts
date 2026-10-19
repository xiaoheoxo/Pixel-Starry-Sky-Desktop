import { describe, expect, it } from 'vitest'
import type { RunTask, RunTaskExt, RunTaskGroup } from '../../../../../shared/types/project-tools'
import { extTaskCommand, TaskCommandError } from './extCommand'
import { taskCommand } from './model'

const task = (name: string): RunTask => ({ name, detail: '', line: null })
const group = (ext: Partial<RunTaskExt>, dir = ''): RunTaskGroup => ({
  kind: 'ext',
  file: dir ? `${dir}/justfile` : 'justfile',
  dir,
  tasks: [],
  ext: {
    packKey: 'k',
    packId: 'p',
    templateId: 't',
    label: 'T',
    command: 'just {name}',
    cwd: '{dir}',
    runner: null,
    runnerLocal: false,
    ...ext,
  },
})

describe('extTaskCommand', () => {
  it('根目录的组不 cd', () => {
    for (const shell of ['pwsh', 'cmd', 'bash', undefined])
      expect(extTaskCommand(group({}), task('build'), shell)).toBe('just build')
  })

  it('子文件夹带空格：各终端的 cd 写法和引号', () => {
    const g = group({}, 'my app')
    expect(extTaskCommand(g, task('build'), 'bash')).toBe("cd 'my app' && just build")
    expect(extTaskCommand(g, task('build'), 'C:\\Windows\\System32\\cmd.exe')).toBe('cd /d "my app" && just build')
    expect(extTaskCommand(g, task('build'), 'pwsh.exe')).toBe(
      "Set-Location -LiteralPath 'my app'; if ($?) { just build }",
    )
  })

  it('PowerShell：弯单引号也双写，不会提前结束字符串', () => {
    const g = group({}, 'x’; calc; ‘y')
    expect(extTaskCommand(g, task('build'), 'pwsh')).toBe(
      "Set-Location -LiteralPath 'x’’; calc; ‘‘y'; if ($?) { just build }",
    )
    expect(extTaskCommand(group({}, "a'b"), task('t'), 'pwsh')).toContain("'a''b'")
  })

  it('不含特殊字符的目录不加引号；cmd 里斜杠换成反斜杠', () => {
    const g = group({}, 'apps/web')
    expect(extTaskCommand(g, task('t'), 'bash')).toBe('cd apps/web && just t')
    expect(extTaskCommand(g, task('t'), 'cmd')).toBe('cd /d apps\\web && just t')
  })

  it('cwd 写成 . 就不 cd，{dir} 可以进命令', () => {
    const g = group({ cwd: '.', command: 'mvn -f {dir}/pom.xml {name}' }, 'svc')
    expect(extTaskCommand(g, task('package'), 'bash')).toBe('mvn -f svc/pom.xml package')
  })

  it('项目里的运行器加前缀：mvnw.cmd → .\\mvnw.cmd / & .\\mvnw.cmd / ./mvnw', () => {
    const win = group({ runner: 'mvnw.cmd', runnerLocal: true, command: '{runner} {name}' })
    expect(extTaskCommand(win, task('package'), 'cmd')).toBe('.\\mvnw.cmd package')
    expect(extTaskCommand(win, task('package'), 'powershell')).toBe('& .\\mvnw.cmd package')
    const nix = group({ runner: './mvnw', runnerLocal: true, command: '{runner} {name}' })
    expect(extTaskCommand(nix, task('package'), 'bash')).toBe('./mvnw package')
    expect(extTaskCommand(nix, task('package'), 'fish')).toBe('./mvnw package')
    expect(extTaskCommand(nix, task('package'), 'pwsh')).toBe('& .\\mvnw package')
  })

  it('不是项目里的运行器原样写', () => {
    const g = group({ runner: 'mvn', runnerLocal: false, command: '{runner} {name}' })
    for (const shell of ['pwsh', 'cmd', 'bash']) expect(extTaskCommand(g, task('package'), shell)).toBe('mvn package')
  })

  it('任务名里的特殊字符按终端转义，替进去的文字不再被替换', () => {
    const g = group({ command: 'run {name} {file}' })
    expect(extTaskCommand(g, task("a b'c"), 'bash')).toBe("run 'a b'\\''c' justfile")
    expect(extTaskCommand(g, task("a b'c"), 'pwsh')).toBe("run 'a b''c' justfile")
    expect(extTaskCommand(g, task('{file}'), 'bash')).toBe("run '{file}' justfile")
  })

  it('taskCommand 对 ext 组走这里', () => {
    expect(taskCommand(group({}), task('x'), 'bash')).toBe('just x')
  })

  it('不知道终端时和内置任务一样：单引号，含单引号按 PowerShell 双写', () => {
    const g = group({ command: 'run {name} {dir}' }, 'cash$box')
    expect(extTaskCommand(g, task("a'b"))).toBe(`cd 'cash$box' && run "a'b" 'cash$box'`)
    expect(extTaskCommand(g, task('x;y'), undefined)).toBe("cd 'cash$box' && run 'x;y' 'cash$box'")
  })

  it('各种特殊字符的任务名和目录', () => {
    for (const shell of ['pwsh', 'bash', undefined])
      for (const name of ['a`b', 'a&b', 'f(1)', '100%', '中文', 'my app'])
        expect(extTaskCommand(group({ cwd: '.' }), task(name), shell)).toBe(`just '${name}'`)
    expect(extTaskCommand(group({ cwd: '.' }), task('f(1)'), 'cmd')).toBe('just "f(1)"')
  })

  it('cmd 下任务名、目录、工作目录含 % 拒绝', () => {
    expect(() => extTaskCommand(group({}), task('50%'), 'cmd')).toThrow(TaskCommandError)
    expect(() => extTaskCommand(group({ command: 'just' }, '100%'), task('x'), 'cmd')).toThrow(TaskCommandError)
    expect(() => extTaskCommand(group({ command: 'just', cwd: '{dir}' }, 'a%b'), task('x'), 'cmd')).toThrow(
      TaskCommandError,
    )
    expect(extTaskCommand(group({}), task('50%'), 'pwsh')).toBe("just '50%'")
  })
})

describe('扩展任务：.cmd / .bat 运行器在 PowerShell 下', () => {
  const bat = (name: string) => group({ runner: name, runnerLocal: true, command: '{runner} {name}' }, 'a&b')
  it('名字、目录含 & 等被拒；普通值照常', () => {
    for (const shell of ['pwsh', 'powershell']) {
      expect(() => extTaskCommand(bat('mvnw.cmd'), task('package'), shell)).toThrow(TaskCommandError)
      expect(() =>
        extTaskCommand(
          group({ runner: 'mvnw.cmd', runnerLocal: true, command: '{runner} {name}' }),
          task('a|b'),
          shell,
        ),
      ).toThrow(TaskCommandError)
    }
    // 没有 .cmd / .bat 扩展名的运行器、别的终端不受影响
    expect(extTaskCommand(bat('mvnw'), task('package'), 'pwsh')).toBe(
      "Set-Location -LiteralPath 'a&b'; if ($?) { & .\\mvnw package }",
    )
    expect(() => extTaskCommand(bat('mvnw.cmd'), task('package'), 'bash')).not.toThrow()
  })
})
