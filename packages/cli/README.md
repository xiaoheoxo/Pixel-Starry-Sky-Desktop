# @pixelsky/cli

像素星空的命令行智能体，命令 `pixelsky`。计划见 `docs/own-cli.md`。

- 基于 [Pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-coding-agent` 1.2.0，MIT）。协议全文见 `LICENSES/pi-coding-agent-MIT.txt`，发布产品时必须随附。
- 换品牌：用 pnpm 补丁（`patches/@earendil-works__pi-coding-agent@1.2.0.patch`）改依赖包 `package.json` 的 `piConfig`（名字 `pixelsky`，配置目录 `.pixelsky`）。升级 Pi 时重新 `pnpm patch` 并检查。
- `src/cli.ts` 在加载 Pi 前设 `PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1`（用户已设置则不覆盖）。
- 配置目录默认 `~/.pixelsky/agent`，可用环境变量 `PIXELSKY_CODING_AGENT_DIR` 改。

## 运行

需要 Node 22.19+（Node 24 直接运行 TS）：

```
node packages/cli/src/cli.ts            # 交互模式
node packages/cli/src/cli.ts --mode rpc # RPC：标准输入输出一行一个 JSON，按 \n 切行，不要用 readline
```

Electron 自带的 Node 也可以：`ELECTRON_RUN_AS_NODE=1 electron.exe packages/cli/src/cli.ts ...`

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
