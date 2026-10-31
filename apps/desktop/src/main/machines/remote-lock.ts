// 远端辅助进程的单实例锁用（remote-entry.ts）。随辅助进程一起打包上传，不导入 electron

/** 结束旧的辅助进程：先 SIGTERM，最多等 graceMs，还在就 SIGKILL 再等 1 秒；结束了返回 true */
export function stopStale(pid: number, graceMs = 5000): boolean {
  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const gone = (ms: number): boolean => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (!alive()) return true
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
    return !alive()
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return !alive()
  }
  if (gone(graceMs)) return true
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* 刚好自己退了 */
  }
  return gone(1000)
}

/** 活着的辅助进程多久刷新一次锁文件的修改时间（没有 /proc 的系统靠它认旧进程） */
export const LOCK_HEARTBEAT_MS = 10_000
/** 锁文件超过这么久没刷新，就当持有它的辅助进程已经不在了（PID 可能已被别的进程复用） */
export const LOCK_STALE_MS = 3 * LOCK_HEARTBEAT_MS

export interface LockProbe {
  platform: NodeJS.Platform
  /** 读 /proc/<pid>/cmdline，读不到时抛错 */
  cmdline: (pid: number) => string
  alive: (pid: number) => boolean
  /** 锁文件距上次刷新过了多久 */
  lockAge: () => number
}

/**
 * 锁里记的 pid 是不是这个命名空间还活着的辅助进程。
 * Linux 照旧看 /proc/<pid>/cmdline；Windows / macOS 没有 /proc，改看进程在不在、锁文件最近有没有被心跳刷新过
 * ——只看进程在不在的话，PID 被别的程序复用时会把它当旧辅助进程结束掉
 */
export function lockHeldByHelper(pid: number, namespace: string, probe: LockProbe): boolean {
  if (probe.platform === 'linux') {
    try {
      const command = probe.cmdline(pid)
      return command.includes('/helper-') && command.split('\0').includes(namespace) && probe.alive(pid)
    } catch {
      return false
    }
  }
  try {
    return probe.lockAge() < LOCK_STALE_MS && probe.alive(pid)
  } catch {
    return false
  }
}
