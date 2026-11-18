// `node helper.cjs runner <子命令>`（docs/multica-learn.md §11.7）。装好后 ~/.local/bin/pixelsky-runner 转到这里。
// 子命令：run（systemd 调）、login <码> [--base 地址]、status、logout、autostart enable|disable。不导入 electron。
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { clearAccount, readAccount } from './account'
import { runDaemon } from './daemon'
import { bundleVersion } from './files'
import { execCommand, pairWithCode, runnerPaths } from './install'
import { UNIT_NAME } from './unit'

const out = (text: string): void => {
  process.stderr.write(text + '\n')
}

/** 单实例：runner.lock 里记着 pid，那个进程还活着、命令行是 runner.cjs 就不再起第二个 */
function takeLock(lock: string): boolean {
  try {
    const pid = Number(readFileSync(lock, 'utf8'))
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0)
        if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('runner.cjs')) return false
      } catch {
        // 进程不在了：锁是旧的
      }
    }
    unlinkSync(lock)
  } catch {
    // 没有锁文件
  }
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export async function runnerMain(argv: string[]): Promise<void> {
  const paths = runnerPaths()
  const [command, ...rest] = argv
  switch (command) {
    case 'run': {
      if (!takeLock(`${paths.dir}/runner.lock`)) {
        out('执行机已经在运行')
        process.exit(2)
      }
      const close = await runDaemon(paths.dir, process.argv[1])
      if (!close) {
        out('执行机还没登录：在桌面的机器页点「设为执行机」，或运行 pixelsky-runner login <配对码> --base <云端地址>')
        // 等一会儿再退出，免得 systemd 每 10 秒拉起一次刷日志
        setTimeout(() => process.exit(0), 5 * 60_000)
        return
      }
      const stop = () => void close().finally(() => process.exit(0))
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
      return
    }
    case 'login': {
      const code = rest[0]
      const baseFlag = rest.indexOf('--base')
      const base = (baseFlag >= 0 ? rest[baseFlag + 1] : readAccount(paths.dir)?.base) ?? ''
      if (!code || !/^https?:\/\//.test(base)) {
        out('用法：pixelsky-runner login <配对码> --base <云端地址>')
        process.exit(2)
      }
      const id = await pairWithCode(paths.dir, base.replace(/\/+$/, ''), code, bundleVersion(paths.script))
      out(`已登录：${id}。重启服务生效：systemctl --user restart ${UNIT_NAME}`)
      return
    }
    case 'status': {
      try {
        process.stdout.write(readFileSync(`${paths.dir}/status.json`, 'utf8') + '\n')
      } catch {
        out('还没有状态（执行机没跑过）')
      }
      return
    }
    case 'logout':
      clearAccount(paths.dir)
      out(`已退出登录。重启服务生效：systemctl --user restart ${UNIT_NAME}`)
      return
    case 'autostart': {
      const on = rest[0] === 'enable'
      if (!on && rest[0] !== 'disable') {
        out('用法：pixelsky-runner autostart enable|disable')
        process.exit(2)
      }
      const r = await execCommand('systemctl', ['--user', on ? 'enable' : 'disable', '--now', UNIT_NAME])
      out(r.ok ? (on ? '已开启开机自启' : '已关闭开机自启') : r.stderr.trim())
      return
    }
    default:
      out('用法：pixelsky-runner run|login|status|logout|autostart')
      process.exit(2)
  }
}
