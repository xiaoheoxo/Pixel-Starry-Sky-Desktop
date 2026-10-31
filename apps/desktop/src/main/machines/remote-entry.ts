import { RpcPeer } from './rpc'
import { createRemoteRuntime } from './remote-runtime'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { isRemoteCliEntry } from './remote-cli'
import { LOCK_HEARTBEAT_MS, lockHeldByHelper, stopStale } from './remote-lock'

// This entry is bundled separately and uploaded over the authenticated SSH connection.
// Never include Electron or desktop credentials in this process.
console.log = (...args) => console.error(...args)
const namespace = process.argv[2] ?? 'default'
if (!/^((ssh|wsl)-[a-f0-9-]+|default)$/.test(namespace)) process.exit(2)
const dir = join(homedir(), '.local', 'share', 'pixelsky', 'remote', 'data', namespace)
mkdirSync(dir, { recursive: true, mode: 0o700 })
const lock = join(dir, 'runtime.lock')
try {
  const pid = Number(readFileSync(lock, 'utf8'))
  const held =
    Number.isInteger(pid) &&
    pid > 0 &&
    pid !== process.pid &&
    lockHeldByHelper(pid, namespace, {
      platform: process.platform,
      cmdline: id => readFileSync(`/proc/${id}/cmdline`, 'utf8'),
      alive: id => {
        try {
          process.kill(id, 0)
          return true
        } catch {
          return false
        }
      },
      lockAge: () => Date.now() - statSync(lock).mtimeMs,
    })
  // ssh- 命名空间是这台桌面在 machines.json 里随机生成的，活着的旧进程只会是断网后半开连接留下的自己：
  // 结束它再接着连。wsl- 的 id 按发行版名算，开发版和安装版会共用，照旧拒绝
  if (held && (!namespace.startsWith('ssh-') || !stopStale(pid))) {
    process.stderr.write('SSH_ALREADY_CONNECTED')
    process.exit(2)
  }
  unlinkSync(lock)
} catch {}
writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
// 心跳：定时刷新锁文件的修改时间，下一个辅助进程据此判断锁的主人还在不在（见 lockHeldByHelper）
setInterval(() => {
  try {
    if (readFileSync(lock, 'utf8') !== String(process.pid)) return
    const now = new Date()
    utimesSync(lock, now, now)
  } catch {}
}, LOCK_HEARTBEAT_MS).unref()
process.once('exit', () => {
  try {
    if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock)
  } catch {}
})
const peer = new RpcPeer(process.stdin, process.stdout, async (method, args) => (await runtime).call(method, args))
// 第三个参数是桌面端装好的像素星空命令行入口；路径必须是本机固定位置的固定格式，其他一律忽略（桌面端传来的也不盲信）
const cliArg = process.argv[3]
const pixelCli =
  cliArg && isRemoteCliEntry(cliArg, homedir(), undefined, process.platform === 'win32') && existsSync(cliArg)
    ? cliArg
    : undefined
const runtime = createRemoteRuntime(peer, dir, pixelCli ? { pixelCli } : {})
let closing = false
const close = () => {
  if (closing) return
  closing = true
  void runtime.then(r => r.close()).finally(() => process.exit(0))
}
peer.onClose = close
process.once('SIGTERM', close)
process.once('SIGINT', close)
process.on('uncaughtException', () => {
  peer.close(new Error('REMOTE_PROCESS_FAILED'))
  close()
})
