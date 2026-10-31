import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LOCK_STALE_MS, lockHeldByHelper, stopStale } from './remote-lock'
import type { LockProbe } from './remote-lock'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('远端辅助进程的旧实例', () => {
  it('结束还活着的旧进程；已经不在的直接算结束', () => {
    // 经一个中间进程启动、中间进程马上退出：目标不是测试进程的子进程（和真实的旧辅助进程一样由别人回收），
    // 否则在 macOS / Linux 上它结束后会因为没人回收一直算「活着」
    const pid = Number(
      execFileSync(process.execPath, [
        '-e',
        "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();process.stdout.write(String(c.pid))",
      ]).toString(),
    )
    expect(alive(pid)).toBe(true)
    expect(stopStale(pid, 2000)).toBe(true)
    expect(alive(pid)).toBe(false)
    expect(stopStale(pid, 100)).toBe(true)
  })
})

describe('认锁文件里的旧辅助进程', () => {
  const ns = 'ssh-ab12'
  const probe = (over: Partial<LockProbe>): LockProbe => ({
    platform: 'linux',
    cmdline: () => {
      throw new Error('ENOENT')
    },
    alive: () => true,
    lockAge: () => 0,
    ...over,
  })
  it('Linux 照旧看 /proc 里的命令行', () => {
    const cmdline = () => ['node', '/home/u/.local/share/pixelsky/remote/x/helper-abc.cjs', ns].join('\0')
    expect(lockHeldByHelper(1, ns, probe({ cmdline }))).toBe(true)
    expect(lockHeldByHelper(1, 'ssh-other', probe({ cmdline }))).toBe(false)
    expect(lockHeldByHelper(1, ns, probe({ cmdline, alive: () => false }))).toBe(false)
    expect(lockHeldByHelper(1, ns, probe({}))).toBe(false)
  })
  it.each(['win32', 'darwin'] as const)('%s 没有 /proc：进程还在、锁最近刷新过才算旧辅助进程', platform => {
    // 以前读 /proc 失败就当过期锁删掉，断线重连会跑起两个辅助进程
    expect(lockHeldByHelper(1, ns, probe({ platform }))).toBe(true)
    expect(lockHeldByHelper(1, ns, probe({ platform, alive: () => false }))).toBe(false)
    // 锁很久没刷新：旧进程早不在了，活着的只会是复用了这个 PID 的别的程序，不能结束它
    expect(lockHeldByHelper(1, ns, probe({ platform, lockAge: () => LOCK_STALE_MS + 1 }))).toBe(false)
    expect(
      lockHeldByHelper(
        1,
        ns,
        probe({
          platform,
          lockAge: () => {
            throw new Error('ENOENT')
          },
        }),
      ),
    ).toBe(false)
  })
})
