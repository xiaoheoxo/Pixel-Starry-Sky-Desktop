// 扩展包不自动安装（docs/own-cli.md §5.1 第二类）：settings.json 的 packages 里写了、本机还没装的 npm / git 来源，
// Pi 默认在启动时直接下载安装（resource-loader 调 packageManager.resolve() 不传 onMissing）。
// 这里把「没传 onMissing」改成跳过：已经装好的包照常加载，`pixelsky list` 等自己传了 onMissing 的不受影响。
// 跳过的来源在会话开始时提示一次（packagesExtension）。
// 只用可擦除的 TS 语法。
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

type MissingAction = 'install' | 'skip' | 'error'
type OnMissing = (source: string) => Promise<MissingAction>
interface Resolver {
  resolve(onMissing?: OnMissing): Promise<unknown>
}

const patched = new WeakSet<object>()
/** 跳过的来源（按出现顺序，不重复） */
const skipped: string[] = []

export function missingPackageMessage(source: string): string {
  return (
    `已跳过没装的扩展包 ${source}：像素星空命令行不会自动下载安装扩展包（settings.json 的 packages）。\n` +
    `Skipped missing package ${source}: the PixelSky CLI does not install packages automatically.`
  )
}

/** 改 DefaultPackageManager.prototype.resolve：调用方没给 onMissing 时一律跳过（Pi 原来是直接安装） */
export function skipMissingPackages(manager: { prototype: Resolver }): void {
  const proto = manager.prototype
  if (patched.has(proto)) return
  patched.add(proto)
  const original = proto.resolve
  proto.resolve = function (this: Resolver, onMissing?: OnMissing) {
    return original.call(
      this,
      onMissing ??
        (async (source: string) => {
          if (!skipped.includes(source)) skipped.push(source)
          return 'skip' as const
        }),
    )
  }
}

/** 测试用 */
export function skippedPackages(): readonly string[] {
  return skipped
}

/** 会话开始时提示跳过了哪些包：有界面时进对话 / 状态栏通知，没有界面（print 模式）时写 stderr */
export function packagesExtension(pi: ExtensionAPI): void {
  let told = 0
  pi.on('session_start', async (_event, ctx) => {
    for (const source of skipped.slice(told)) {
      if (ctx.hasUI) ctx.ui.notify(missingPackageMessage(source), 'warning')
      else console.error(missingPackageMessage(source))
    }
    told = skipped.length
  })
}
