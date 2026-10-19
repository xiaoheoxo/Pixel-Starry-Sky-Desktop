#!/usr/bin/env node
// 像素星空命令行入口：基于 Pi（MIT），品牌 / 配置目录由依赖包 package.json 的 piConfig 补丁换成
// pixelsky / .pixelsky-cli（补丁见 patches/，说明见 docs/own-cli.md §5.1）。
// 注意：只用可擦除的 TS 语法（Node 直接剥类型运行）。
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { interceptArgv } from './argv.ts'
import { createApprovalExtension } from './extensions/approval.ts'
import { gatewayExtension } from './extensions/gateway.ts'
import { loopGuardExtension } from './extensions/loopGuard.ts'
import { mcpExtension } from './extensions/mcp.ts'
import { packagesExtension, skipMissingPackages } from './packages.ts'
import { SUBAGENT_ENV, createSubagentExtension } from './tools/subagent.ts'
import { todoExtension } from './tools/todo.ts'
import { webExtension } from './tools/web.ts'

// 关安装统计和版本检查；用户自己设了环境变量就不覆盖。
process.env.PI_TELEMETRY ??= '0'
process.env.PI_SKIP_VERSION_CHECK ??= '1'

// 随包的 rg / fd：接在 PATH 最后，用户自己装的优先。安装包里在 pixel.mjs 旁边的 bin/（after-pack.cjs 按架构放），
// 开发时在 packages/cli/vendor/<平台>-<架构>/（scripts/tools.mjs 下载）。
// Pi 找这两个工具先看配置目录的 bin/、再看 PATH（tools-manager.js getToolPath），bash 工具里也能直接用。
const bundledBin = [
  process.env.PIXELSKY_CLI_BIN_DIR?.trim(),
  fileURLToPath(new URL('./bin', import.meta.url)),
  fileURLToPath(new URL(`../vendor/${process.platform}-${process.arch}`, import.meta.url)),
].find(dir => dir && existsSync(dir))
if (bundledBin) {
  const key = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  const parts = (process.env[key] ?? '').split(delimiter).filter(Boolean)
  if (!parts.includes(bundledBin)) process.env[key] = [...parts, bundledBin].join(delimiter)
}

const intercepted = interceptArgv(process.argv.slice(2))
if (intercepted.action === 'blocked') {
  console.error(intercepted.message)
  process.exit(intercepted.exitCode)
}

// 必须在设置环境变量之后再加载 Pi
const { main, DefaultPackageManager } = await import('@earendil-works/pi-coding-agent')
// settings.json 里写了但本机没装的扩展包：跳过，不自动下载安装（packages.ts）
skipMissingPackages(DefaultPackageManager)
if (intercepted.action === 'run') {
  // 子智能体（task 工具起的子进程）不再派子智能体，计划由主智能体交
  const subagent = process.env[SUBAGENT_ENV] === '1'
  const approval = createApprovalExtension({ subagent })
  await main(intercepted.args, {
    extensionFactories: [
      gatewayExtension,
      packagesExtension,
      mcpExtension,
      // 在审批前面：拦下的重复调用不用再问用户
      loopGuardExtension,
      approval,
      todoExtension,
      webExtension,
      ...(subagent
        ? []
        : [
            createSubagentExtension({
              mode: approval.currentMode,
              rules: approval,
              onModeChange: approval.onModeChange,
            }),
          ]),
    ],
  })
}
