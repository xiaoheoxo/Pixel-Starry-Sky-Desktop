import type { CommandWrapper } from '@pixelsky/protocol'

/**
 * Codex 给的 command 是 argv 用 shlex 拼成的一行，外面包着一层 shell
 * （Windows 上是 `"C:\\…\\powershell.exe" -Command "…"`，其他平台是 `/bin/bash -lc '…'`）。
 * 显示时去掉这层，只留里面的脚本（Codex App 也这么显示）；认不出来的原样返回
 */
export function codexCommand(line: string): string {
  return codexCommandParts(line).command
}

/** 同 codexCommand，另外在真的拆过外壳时带上 wrapper（原始整行、外壳名、引出脚本的开关以外的参数） */
export function codexCommandParts(line: string): { command: string; wrapper?: CommandWrapper } {
  const argv = shellWords(line)
  if (!argv || argv.length < 2) return { command: line }
  const shell = argv[0]!
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '')
  let at = -1
  // 引出脚本的那个开关在 argv 里的下标，以及它前面哪些参数算额外的
  let extra: string[] = []
  if (/^(?:ba|z|da|k)?sh$/.test(shell)) {
    // bash -lc / -c / -l -c：脚本是最后一个参数，前面只能是短选项
    const flags = argv.slice(1, -1)
    if (flags.length && flags.every(f => /^-[a-z]+$/.test(f)) && flags.some(f => f.includes('c'))) {
      at = argv.length - 1
      extra = flags.filter(f => !/^-[lc]+$/.test(f))
    }
  } else if (shell === 'powershell' || shell === 'pwsh') {
    const sw = argv.findIndex((a, i) => i > 0 && /^-c(?:ommand)?$/i.test(a))
    if (sw > 0) {
      at = sw + 1
      extra = argv.slice(1, sw)
    }
  } else if (shell === 'cmd') {
    const sw = argv.findIndex((a, i) => i > 0 && /^\/c$/i.test(a))
    if (sw > 0) {
      at = sw + 1
      extra = argv.slice(1, sw)
    }
  }
  if (at <= 0 || at >= argv.length) return { command: line }
  const script = argv.slice(at).join(' ').trim()
  if (!script) return { command: line }
  return { command: script, wrapper: { line, shell, extra } }
}

/** 按 POSIX shell 的引号规则拆词（shlex 拼接的逆过程）；引号没闭合返回 null */
export function shellWords(line: string): string[] | null {
  const words: string[] = []
  let word = '',
    has = false,
    i = 0
  while (i < line.length) {
    const c = line[i]!
    if (/\s/.test(c)) {
      if (has) words.push(word)
      word = ''
      has = false
      i++
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1)
      if (end < 0) return null
      word += line.slice(i + 1, end)
      has = true
      i = end + 1
    } else if (c === '"') {
      i++
      for (;;) {
        if (i >= line.length) return null
        const d = line[i]!
        if (d === '"') break
        // 双引号里反斜杠只转义 $ ` " \ 和换行，其他照原样留着
        if (d === '\\' && i + 1 < line.length && '$`"\\\n'.includes(line[i + 1]!)) {
          if (line[i + 1] !== '\n') word += line[i + 1]
          i += 2
        } else {
          word += d
          i++
        }
      }
      has = true
      i++
    } else if (c === '\\' && i + 1 < line.length) {
      if (line[i + 1] !== '\n') word += line[i + 1]
      has = true
      i += 2
    } else {
      word += c
      has = true
      i++
    }
  }
  if (has) words.push(word)
  return words
}
