// 内置任务命令的引号：目录名 / 任务名里的 $ ` ' ; & ( % 空格 中文，在各种终端里都要原样传给 npm / make / cargo / gradle
import { describe, expect, it } from 'vitest'
import type { RunTaskGroup } from '../../../../../shared/types/project-tools'
import { TaskCommandError, taskCommand } from './model'

const task = (name: string) => ({ name, detail: '', line: null })
const npm = (dir: string, manager: RunTaskGroup['manager'] = 'npm'): RunTaskGroup => ({
  kind: 'npm',
  file: `${dir}/package.json`,
  dir,
  manager,
  tasks: [],
})
const make = (dir: string): RunTaskGroup => ({ kind: 'make', file: `${dir}/Makefile`, dir, tasks: [] })
const cargo = (dir: string): RunTaskGroup => ({ kind: 'cargo', file: `${dir}/Cargo.toml`, dir, tasks: [] })
const gradle = (buildDir: string, project = ':'): RunTaskGroup => ({
  kind: 'gradle',
  file: `${buildDir}/build.gradle`,
  dir: buildDir,
  tasks: [],
  gradle: { buildDir, project, name: project, wrapper: true, stamp: 's', plugin: null },
})

// 目录名 → [pwsh, powershell, bash, 未知]（cmd 另测）；cmd 的双引号规则见下
const SINGLE: Array<[string, string]> = [
  ['cash$box', "'cash$box'"],
  ['a`b', "'a`b'"],
  ["a'b", "'a''b'"],
  ['x;y', "'x;y'"],
  ['a&b', "'a&b'"],
  ['f(1)', "'f(1)'"],
  ['100%', "'100%'"],
  ['my app', "'my app'"],
  ['中文目录', "'中文目录'"],
  ['@scope', "'@scope'"],
]

describe('内置任务命令的引号', () => {
  it('只含安全字符时和以前一样', () => {
    for (const shell of [undefined, 'pwsh', 'powershell.exe', 'cmd', 'bash'])
      expect(taskCommand(npm('apps/web'), task('build:prod'), shell)).toBe('npm --prefix apps/web run build:prod')
  })

  it('PowerShell：单引号，单引号双写', () => {
    for (const shell of ['pwsh', 'powershell', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'])
      for (const [dir, quoted] of SINGLE) {
        expect(taskCommand(npm(dir), task('build'), shell)).toBe(`npm --prefix ${quoted} run build`)
        expect(taskCommand(npm(dir, 'pnpm'), task(dir), shell)).toBe(`pnpm --dir ${quoted} run ${quoted}`)
        expect(taskCommand(npm(dir, 'yarn'), task('b'), shell)).toBe(`yarn --cwd ${quoted} run b`)
        expect(taskCommand(make(dir), task(dir), shell)).toBe(`make -C ${quoted} ${quoted}`)
      }
  })

  it('未知终端：单引号；含单引号且没有别的特殊字符时改用双引号，否则按 PowerShell 双写', () => {
    for (const [dir, quoted] of SINGLE) {
      const expected = dir === "a'b" ? `"a'b"` : quoted
      expect(taskCommand(npm(dir), task('build'))).toBe(`npm --prefix ${expected} run build`)
    }
    expect(taskCommand(npm("it's"), task('x'))).toBe(`npm --prefix "it's" run x`)
    expect(taskCommand(npm("it's $HOME"), task('x'))).toBe("npm --prefix 'it''s $HOME' run x")
    expect(taskCommand(npm("it's `x`"), task('x'))).toBe("npm --prefix 'it''s `x`' run x")
    expect(taskCommand(npm("it's !"), task('x'))).toBe("npm --prefix 'it''s !' run x")
  })

  it('开头是 = 的值要加引号（zsh 会展开 =cmd）', () => {
    expect(taskCommand(npm('=x'), task('b'), 'zsh')).toBe("npm --prefix '=x' run b")
    expect(taskCommand(npm('a=b'), task('b'), 'zsh')).toBe('npm --prefix a=b run b')
  })

  it('PowerShell 弯单引号也双写', () => {
    expect(taskCommand(npm('a\u2019b'), task('x'), 'pwsh')).toBe("npm --prefix 'a\u2019\u2019b' run x")
  })

  it('bash：单引号，值里的单引号写成 引号 反斜杠 引号 引号', () => {
    for (const [dir] of SINGLE) {
      const quoted = `'${dir.replaceAll("'", "'\\''")}'`
      expect(taskCommand(npm(dir), task('build'), 'bash')).toBe(`npm --prefix ${quoted} run build`)
    }
    expect(taskCommand(npm("a'b"), task('x'), '/bin/zsh')).toBe("npm --prefix 'a'\\''b' run x")
  })

  it('cmd：双引号，" 写成 ""', () => {
    for (const dir of ['cash$box', 'a`b', "a'b", 'x;y', 'a&b', 'f(1)', 'my app', '中文目录'])
      expect(taskCommand(npm(dir), task('build'), 'cmd')).toBe(`npm --prefix "${dir}" run build`)
    expect(taskCommand(npm('a"b'), task('x'), 'cmd.exe')).toBe('npm --prefix "a""b" run x')
  })

  it('cargo：子命令名和 manifest 路径', () => {
    expect(taskCommand(cargo('my app'), task('build'), 'bash')).toBe("cargo build --manifest-path 'my app/Cargo.toml'")
    expect(taskCommand(cargo("a'b"), task('b$'), 'pwsh')).toBe("cargo 'b$' --manifest-path 'a''b/Cargo.toml'")
    expect(taskCommand(cargo('a;b'), task('run'), 'cmd')).toBe('cargo run --manifest-path "a;b/Cargo.toml"')
    expect(taskCommand(cargo('a;b'), task('run'))).toBe("cargo run --manifest-path 'a;b/Cargo.toml'")
  })

  it('gradle：-p 目录、wrapper 路径、任务路径', () => {
    const g = gradle('sub$dir', ':a;b')
    const t = task('build')
    expect(taskCommand(g, t, 'pwsh')).toBe("& './sub$dir/gradlew' -p 'sub$dir' ':a;b:build'")
    expect(taskCommand(g, t, 'bash')).toBe("'./sub$dir/gradlew' -p 'sub$dir' ':a;b:build'")
    expect(taskCommand(g, t, 'cmd')).toBe('".\\sub$dir\\gradlew.bat" -p "sub$dir" ":a;b:build"')
    expect(taskCommand(g, t)).toBe("'./sub$dir/gradlew' -p 'sub$dir' ':a;b:build'")
    expect(taskCommand(gradle('x y'), task('build'), 'cmd')).toBe('".\\x y\\gradlew.bat" -p "x y" build')
    expect(taskCommand(gradle('android'), task('build'), 'cmd')).toBe('.\\android\\gradlew.bat -p android build')
  })

  it('cmd 下 % 拒绝：目录、任务名、manifest、gradle', () => {
    const run = (group: RunTaskGroup, name: string): string => taskCommand(group, task(name), 'cmd')
    expect(() => run(npm('100%'), 'build')).toThrow(TaskCommandError)
    expect(() => run(npm('a'), '%PATH%')).toThrow(TaskCommandError)
    expect(() => run(make('a%b'), 'all')).toThrow(TaskCommandError)
    expect(() => run(cargo('a%b'), 'run')).toThrow(TaskCommandError)
    expect(() => run(gradle('a%b'), 'build')).toThrow(TaskCommandError)
    expect(() => run(gradle('a', ':x%'), 'build')).toThrow(TaskCommandError)
    // 其他终端里 % 只是普通字符
    for (const shell of ['pwsh', 'bash', undefined])
      expect(taskCommand(npm('100%'), task('b'), shell)).toBe("npm --prefix '100%' run b")
  })
})

describe('PowerShell 调用批处理（Gradle）', () => {
  const run = (group: RunTaskGroup, shell: string, name = 'build'): string => taskCommand(group, task(name), shell)

  it('pwsh / powershell + gradle：目录、任务路径含 & | < > ^ % " 被拒', () => {
    for (const shell of ['pwsh', 'powershell'])
      for (const bad of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%b']) {
        expect(() => run(gradle(bad), shell), `${shell} ${bad}`).toThrow(TaskCommandError)
        expect(() => run(gradle('ok', `:${bad}`), shell)).toThrow(TaskCommandError)
        expect(() => run(gradle('ok'), shell, bad)).toThrow(TaskCommandError)
      }
    expect(() => run(gradle('a"b'), 'pwsh')).toThrow(TaskCommandError)
    try {
      run(gradle('a&b'), 'pwsh')
    } catch (e) {
      expect((e as TaskCommandError).code).toBe('psBatch')
    }
  })

  it('其他特殊字符照常加引号；其他终端不受影响', () => {
    expect(run(gradle('a;b'), 'pwsh')).toBe("& './a;b/gradlew' -p 'a;b' build")
    expect(run(gradle('a$b'), 'powershell')).toBe("& './a$b/gradlew' -p 'a$b' build")
    expect(run(gradle('a&b'), 'bash')).toBe("'./a&b/gradlew' -p 'a&b' build")
    expect(run(gradle('a&b'), 'cmd')).toBe('".\\a&b\\gradlew.bat" -p "a&b" build')
    expect(taskCommand(gradle('a&b'), task('build'))).toBe("'./a&b/gradlew' -p 'a&b' build")
  })

  it('Windows PowerShell 5.1 下含 " 的值被拒，pwsh 7 不受影响', () => {
    expect(() => taskCommand(npm('a"b'), task('x'), 'powershell.exe')).toThrow(TaskCommandError)
    expect(() => taskCommand(npm('ok'), task('a"b'), 'powershell')).toThrow(TaskCommandError)
    expect(taskCommand(npm('a"b'), task('x'), 'pwsh')).toBe("npm --prefix 'a\"b' run x")
  })

  it('npm 的 & 目录在 pwsh 下照常（只有 .cmd 包装时检测不到，见 docs）', () => {
    expect(taskCommand(npm('a&b'), task('x'), 'pwsh')).toBe("npm --prefix 'a&b' run x")
  })
})
