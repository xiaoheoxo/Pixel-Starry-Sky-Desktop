import { RpcPeer } from './rpc'
import { createRemoteRuntime } from './remote-runtime'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isRemoteCliEntry } from './remote-cli'

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
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      if (command.includes('/helper-') && command.split('\0').includes(namespace)) {
        process.kill(pid, 0)
        process.stderr.write('SSH_ALREADY_CONNECTED')
        process.exit(2)
      }
    } catch {
      /* Stale lock or PID reused by another process. */
    }
  }
  unlinkSync(lock)
} catch {}
writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
process.once('exit', () => {
  try {
    if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock)
  } catch {}
})
const peer = new RpcPeer(process.stdin, process.stdout, async (method, args) => (await runtime).call(method, args))
// 第三个参数是桌面端装好的像素星空命令行入口；路径必须是本机固定位置的固定格式，其他一律忽略（桌面端传来的也不盲信）
const cliArg = process.argv[3]
const pixelCli = cliArg && isRemoteCliEntry(cliArg, homedir()) && existsSync(cliArg) ? cliArg : undefined
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
