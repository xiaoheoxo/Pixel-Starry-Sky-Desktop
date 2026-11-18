// 执行机开机自启（docs/multica-learn.md §11.7，§12 第 5 问：第一版只做 Linux）：systemd 用户单元和
// ~/.local/bin/pixelsky-runner 小脚本的文本。纯函数，命令由调用方执行。

/** systemd 单元文件里的一个参数：照 systemd.syntax 的规则加引号，反斜杠、引号、% 转义 */
export function systemdArg(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error('路径里有换行，写不进 systemd 单元')
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  return `"${escaped}"`
}

/** Environment= 一项：KEY=VALUE 整体加引号 */
function systemdEnv(key: string, value: string): string {
  return systemdArg(`${key}=${value}`)
}

export interface UnitInput {
  /** 跑执行机的 node（安装时 helper 用的那个 process.execPath） */
  node: string
  /** runner.cjs 的绝对路径 */
  script: string
  /**
   * 安装时 helper 进程的 PATH：桌面经 SSH 找得到引擎用的就是它；systemd 自己的 PATH 找不到 nvm 装的 node、
   * npm 全局的 claude / codex
   */
  path: string
}

export function unitText(input: UnitInput): string {
  return [
    '[Unit]',
    'Description=PixelSky runner (team work while the desktop is closed)',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${systemdArg(input.node)} ${systemdArg(input.script)} runner run`,
    `Environment=${systemdEnv('PATH', input.path)}`,
    'Restart=always',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** POSIX shell 单引号：' 写成 '\'' */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** ~/.local/bin/pixelsky-runner：转给 runner.cjs */
export function wrapperText(node: string, script: string): string {
  return `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(script)} runner "$@"\n`
}

export const UNIT_NAME = 'pixelsky-runner.service'
