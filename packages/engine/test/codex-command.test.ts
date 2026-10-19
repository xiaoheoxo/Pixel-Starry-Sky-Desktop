import { describe, expect, it } from 'vitest'
import { codexCommand, codexCommandParts, shellWords } from '../src/codex/command'

describe('Codex 命令：去掉外面那层 shell', () => {
  it('Windows PowerShell：双引号里的 \\\\ 还原成一个反斜杠，只留 -Command 后面的脚本', () => {
    expect(
      codexCommand(
        `"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "rg -n 'Core' src"`,
      ),
    ).toBe("rg -n 'Core' src")
    expect(codexCommand(`"C:\\\\WINDOWS\\\\powershell.exe" -Command '.\\gradlew.bat test'`)).toBe('.\\gradlew.bat test')
    expect(codexCommand(`pwsh.exe -NoProfile -Command '$x=Get-Content a.txt; "$x"'`)).toBe('$x=Get-Content a.txt; "$x"')
  })

  it('bash -lc / sh -c / cmd /c 都能拆；多行脚本原样保留', () => {
    expect(codexCommand(`/bin/bash -lc 'git status --short'`)).toBe('git status --short')
    expect(codexCommand(`bash -lc "echo \\"hi\\" && ls"`)).toBe('echo "hi" && ls')
    expect(codexCommand(`/bin/zsh -l -c 'cat <<EOF\na\nEOF'`)).toBe('cat <<EOF\na\nEOF')
    expect(codexCommand(`cmd.exe /d /c dir /b`)).toBe('dir /b')
    // shlex 拼单引号：'it'"'"'s'
    expect(codexCommand(`bash -lc 'echo '"'"'it'"'"''`)).toBe("echo 'it'")
  })

  it('认不出来的原样返回：不是 shell、没有 -c、引号没闭合', () => {
    for (const line of ['ls -la', 'npm test', 'bash script.sh', 'powershell.exe -File a.ps1', `bash -lc 'oops`, ''])
      expect(codexCommand(line)).toBe(line)
  })

  it('shellWords 按 POSIX 引号规则拆词', () => {
    expect(shellWords(`a 'b c' "d\\"e" f\\ g ''`)).toEqual(['a', 'b c', 'd"e', 'f g', ''])
    expect(shellWords(`"a\\nb"`)).toEqual(['a\\nb'])
    expect(shellWords(`"open`)).toBeNull()
  })
})

describe('Codex 命令：外壳信息 codexCommandParts', () => {
  const ps = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"'
  it('默认 powershell -Command：没有额外参数，带原始整行', () => {
    const line = `${ps} -Command "rg -n 'Core' src"`
    expect(codexCommandParts(line)).toEqual({
      command: "rg -n 'Core' src",
      wrapper: { line, shell: 'powershell', extra: [] },
    })
  })

  it('-Command 前面的参数算额外', () => {
    const r = codexCommandParts(`${ps} -NoProfile -ExecutionPolicy Bypass -Command "ls"`)
    expect(r.command).toBe('ls')
    expect(r.wrapper?.extra).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass'])
    expect(codexCommandParts(`pwsh -NoProfile -c ls`).wrapper).toMatchObject({ shell: 'pwsh', extra: ['-NoProfile'] })
  })

  it('bash：-lc / -c / -l -c 不算额外，其他开关算', () => {
    expect(codexCommandParts(`/bin/bash -lc 'git status'`).wrapper).toMatchObject({ shell: 'bash', extra: [] })
    expect(codexCommandParts(`/bin/zsh -l -c 'ls'`).wrapper).toMatchObject({ shell: 'zsh', extra: [] })
    expect(codexCommandParts(`bash -e -c 'ls'`).wrapper?.extra).toEqual(['-e'])
    expect(codexCommandParts(`sh -x -lc 'ls'`).wrapper).toMatchObject({ shell: 'sh', extra: ['-x'] })
  })

  it('cmd：/c 不算额外，/d /s 算', () => {
    expect(codexCommandParts(`cmd.exe /d /s /c dir`)).toMatchObject({
      command: 'dir',
      wrapper: { shell: 'cmd', extra: ['/d', '/s'] },
    })
    expect(codexCommandParts(`cmd /C dir`).wrapper?.extra).toEqual([])
  })

  it('认不出来的没有 wrapper', () => {
    for (const line of ['ls -la', 'bash script.sh', 'powershell.exe -File a.ps1', `bash -lc 'oops`, ''])
      expect(codexCommandParts(line)).toEqual({ command: line })
  })
})
