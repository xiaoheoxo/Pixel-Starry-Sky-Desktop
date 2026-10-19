// 「加载完整列表」（docs/ui/coding-tasks.md §9.2）：在构建根目录跑 `gradlew tasks --all --console=plain`
import { spawn, type ChildProcess } from 'node:child_process'
import { access, constants, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GradleListedTask } from '../../../shared/types/project-tools'
import { decodeConsoleText as decodeOutput, detectOemCodePage } from '@pixelsky/engine'
import { inside } from './common'
import { parseGradleTaskList } from './gradle'

const TIMEOUT_MS = 10 * 60 * 1000
const MAX_OUTPUT = 4 * 1024 * 1024
const TAIL_BYTES = 16 * 1024
const TASKS_ARGS = 'tasks --all --console=plain'

interface Running {
  readonly child: ChildProcess | null
  promise: Promise<GradleListedTask[]>
  cancel(): void
}
/** 正在跑的进程：构建根目录绝对路径 → 进程 */
const running = new Map<string, Running>()

/** buildDir 必须是工作区里的相对 posix 路径：不能绝对、不能有 .. ；根是 '' */
export function checkBuildDir(buildDir: string): string[] {
  if (buildDir.includes('\\') || buildDir.includes('\0') || buildDir.startsWith('/') || /^[a-zA-Z]:/.test(buildDir))
    throw new Error('构建目录不正确')
  const parts = buildDir.split('/').filter(part => part && part !== '.')
  if (parts.includes('..')) throw new Error('构建目录不正确')
  return parts
}

export interface GradleLaunch {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

/** 怎么启动：Windows 经 cmd /d /s /c；posix 优先 ./gradlew（没有执行权限用 sh gradlew）；没有 wrapper 用 PATH 里的 gradle */
export function gradleLaunch(platform: string, wrapper: 'none' | 'exec' | 'script'): GradleLaunch {
  if (platform === 'win32') {
    // 写 .\gradlew.bat：设了 NoDefaultCurrentDirectoryInExePath 时 cmd 不在当前目录找
    const exe = wrapper === 'none' ? 'gradle' : '.\\gradlew.bat'
    // cmd 本身用绝对路径（ComSpec）：按名字找时会先在项目目录里找 cmd.exe
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${exe} ${TASKS_ARGS}"`],
      windowsVerbatimArguments: true,
    }
  }
  if (wrapper === 'exec') return { command: './gradlew', args: TASKS_ARGS.split(' ') }
  if (wrapper === 'script') return { command: 'sh', args: ['gradlew', ...TASKS_ARGS.split(' ')] }
  return { command: 'gradle', args: TASKS_ARGS.split(' ') }
}

async function detectWrapper(dir: string): Promise<'none' | 'exec' | 'script'> {
  if (process.platform === 'win32') {
    try {
      await stat(join(dir, 'gradlew.bat'))
      return 'exec'
    } catch {
      return 'none'
    }
  }
  try {
    await stat(join(dir, 'gradlew'))
  } catch {
    return 'none'
  }
  try {
    await access(join(dir, 'gradlew'), constants.X_OK)
    return 'exec'
  } catch {
    return 'script'
  }
}

function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
      'error',
      () => {},
    )
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

const lastLines = (text: string, count: number) => text.trimEnd().split(/\r?\n/).slice(-count).join('\n')

export function listGradleTasks(root: string, buildDir: string): Promise<GradleListedTask[]> {
  const parts = checkBuildDir(buildDir)
  const dir = parts.length ? join(root, ...parts) : root
  if (!inside(root, dir)) throw new Error('构建目录不正确')
  const existing = running.get(dir)
  if (existing) return existing.promise

  // 先登记再启动：启动前（检查 wrapper 的间隙）再来的调用也能拿到同一个结果，取消也能生效
  let child: ChildProcess | null = null
  let settled = false
  let timer: NodeJS.Timeout | undefined
  let fail: (error: Error) => void = () => {}
  const entry: Running = {
    get child() {
      return child
    },
    promise: new Promise<GradleListedTask[]>((resolve, reject) => {
      fail = error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (running.get(dir) === entry) running.delete(dir)
        if (child) killTree(child)
        reject(error)
      }
      const done = (tasks: GradleListedTask[]) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (running.get(dir) === entry) running.delete(dir)
        resolve(tasks)
      }
      void (async () => {
        // 顺便查好系统代码页（只查一次），结束时解码输出要用
        const [wrapper] = await Promise.all([detectWrapper(dir), detectOemCodePage()])
        if (settled) return
        const launch = gradleLaunch(process.platform, wrapper)
        const proc = spawn(launch.command, launch.args, {
          cwd: dir,
          windowsHide: true,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        child = proc
        timer = setTimeout(() => fail(new Error('Gradle 超过 10 分钟没有结果，已结束')), TIMEOUT_MS)
        // 按字节收，结束时再解码（UTF-8，Windows 上退到系统代码页，见 decodeConsoleText）
        const chunks: Buffer[] = []
        let size = 0
        let tail = Buffer.alloc(0)
        const onData = (chunk: Buffer) => {
          if (size < MAX_OUTPUT) {
            chunks.push(chunk)
            size += chunk.length
          }
          tail = Buffer.concat([tail, chunk]).subarray(-TAIL_BYTES)
        }
        proc.stdout?.on('data', onData)
        proc.stderr?.on('data', onData)
        proc.on('error', error => fail(new Error(`无法启动 Gradle：${error.message}`)))
        proc.on('close', code => {
          if (code === 0) {
            done(parseGradleTaskList(decodeOutput(Buffer.concat(chunks))))
            return
          }
          // 只留了末尾一段时开头可能切在字符中间：从第一个换行之后开始解
          const from = tail.length >= TAIL_BYTES ? tail.indexOf(0x0a) + 1 : 0
          fail(
            new Error(
              `gradle tasks 失败（退出码 ${code ?? '未知'}）\n${lastLines(decodeOutput(tail.subarray(from)), 20)}`,
            ),
          )
        })
      })().catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
    }),
    cancel: () => fail(new Error('已取消')),
  }
  running.set(dir, entry)
  return entry.promise
}

export async function cancelGradleTasks(root: string, buildDir: string): Promise<void> {
  const parts = checkBuildDir(buildDir)
  const dir = parts.length ? join(root, ...parts) : root
  running.get(dir)?.cancel()
}
