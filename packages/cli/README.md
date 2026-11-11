# @pixelsky/cli

像素星空的命令行智能体，命令 `pixelsky`。计划见 `docs/own-cli.md`。

- 基于 [Pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent` 1.5.0，MIT）。协议全文见 `LICENSES/pi-coding-agent-MIT.txt`，发布产品时必须随附。
- 换品牌：用 pnpm 补丁（`patches/@earendil-works__pi-coding-agent@1.5.0.patch`）改依赖包 `package.json` 的 `piConfig`（名字 `pixelsky`，配置目录 `.pixelsky-cli`）。升级 Pi 时重新 `pnpm patch` 并检查。
- `src/cli.ts` 在加载 Pi 前设 `PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`（用户已设置则不覆盖）。
- 配置目录默认 `~/.pixelsky-cli/agent`，可用环境变量 `PIXELSKY_CODING_AGENT_DIR` 改。

## 运行

需要 Node 22.19+（Node 24 直接运行 TS）：

```
node packages/cli/src/cli.ts            # 交互模式
node packages/cli/src/cli.ts --mode rpc # RPC：标准输入输出一行一个 JSON，按 \n 切行，不要用 readline
```

Electron 自带的 Node 也可以：`ELECTRON_RUN_AS_NODE=1 electron.exe packages/cli/src/cli.ts ...`

## 目标模式

在交互模式或桌面端选择像素星空引擎后，输入 `/goal 要完成的目标`。模型会持续执行，使用 `get_goal` 查看目标和用量，完成后用 `update_goal` 报告结果。普通请求不会自动建立目标；自然语言明确要求目标模式时，模型也可以使用 `create_goal`。

- `/goal` 查看；`/goal pause` 暂停自动续轮，当前轮继续完成；`/goal resume` 继续；`/goal clear` 清除目标。
- 桌面端复用目标栏，显示状态、token 用量和耗时，可展开修改目标及可选 token 预算。预算耗尽后停止；点击「继续」打开编辑器，确认新的目标/预算后重新计数。
- 「停止」会中断当前轮并暂停目标。应用退出会保存并暂挂目标，重新打开不会自动执行，下一条普通消息才继续；手动暂停的目标须明确恢复。
- 目标模式保留计划模式、工具审批和循环检测。模型连续三轮遇到相同阻碍时可标记为阻塞；请求失败或循环检测终止时也会停止自动续轮。

目标和用量保存在当前 Pi 会话分支的自定义条目中。自动续轮不会伪装成用户消息；改目标后，旧请求不能完成新目标，也不会占用新目标的预算。

## 打包

随安装包发布用两个脚本（桌面版 `pnpm build` 会先跑 `bundle`，release.yml 在 electron-builder 之前跑 `smoke`）：

- `pnpm --filter @pixelsky/cli bundle`：esbuild 把 `src/cli.ts`（连同打过补丁的 Pi 和全部 JS 依赖）打成 `dist/pixel-cli/pixel.mjs`，再把运行时按路径读取的文件按 Pi 自己的目录结构放在旁边。没有原生模块，跟架构无关（约 14 MB）。
- `pnpm --filter @pixelsky/cli smoke`：用 Node（或 `--exe` 指定的 Electron + `ELECTRON_RUN_AS_NODE`）检查 `--version`、`--help` 的品牌、RPC 的 `get_state` / `get_commands` / `get_available_models` 和自带扩展。不调模型。`--entry` 可指向安装包里的 `resources/pixel-cli/pixel.mjs`。

产出目录：

```
dist/pixel-cli/
  pixel.mjs  package.json（piConfig 品牌）  codemode-worker.js  image-resize-worker.js
  dist/modes/interactive/{theme,assets}  dist/core/export-html
  node_modules/@silvia-odwyer/photon-node  node_modules/quickjs-wasi   （wasm 按路径读）
  LICENSES/  THIRD_PARTY_NOTICES.txt
```

注意：
- 不能直接输出到 `dist/` 根目录：Pi 从 `pixel.mjs` 往上找 `package.json`，目录叫 `dist` 时会越过去认成 `packages/cli/package.json`，品牌退回 `pi`。
- 升级 Pi 后检查：两个 worker 文件名（`dist/bundle/chunks/`）、pnpm 补丁是否仍生效（bundle 会检查 `piConfig.name`）、`smoke` 是否通过。
- 安装包里 `node_modules` 由 `apps/desktop/build/after-pack.cjs` 补拷并检查，缺文件会让打包失败。
