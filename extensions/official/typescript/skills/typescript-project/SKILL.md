---
name: typescript-project
description: 在 TypeScript / JavaScript 项目里写代码、跑测试、查类型、修报错时使用，先认包管理器和工具链再动手。Use when working in a TypeScript or JavaScript project: detect the package manager and toolchain, run tsc/tests/lint/format, fix compiler errors.
---

# TypeScript / JavaScript 项目工作流

先认清项目自己用的工具，再动手。**不擅自换工具、不装新依赖、不改锁文件以外的包管理配置**；要加依赖先问用户。

## 认包管理器（看锁文件，不看你的习惯）

| 锁文件 / 配置 | 工具 | 安装 | 运行脚本 | 一次性执行 |
| --- | --- | --- | --- | --- |
| `pnpm-lock.yaml` | pnpm | `pnpm install` | `pnpm run <脚本>` | `pnpm exec <命令>` |
| `yarn.lock` | yarn | `yarn install` | `yarn <脚本>` | `yarn <命令>`（Berry 也可 `yarn exec`） |
| `package-lock.json` | npm | `npm ci` | `npm run <脚本>` | `npx <命令>` |
| `bun.lock` / `bun.lockb` | bun | `bun install` | `bun run <脚本>` | `bunx <命令>` |
| `deno.json` / `deno.jsonc` | deno | 无需安装 | `deno task <任务>` | 无（见第 3 节 Deno 说明） |

- 同时有多个锁文件时，看 `package.json` 的 `packageManager` 字段，仍不确定就问用户。
- 没有锁文件时，不要自己 `install` 生成一个，先问用户用哪个。
- 只改代码时不需要重新安装；`node_modules` 缺失或报找不到模块再安装。

## 先看项目有哪些脚本和配置

- 读 `package.json` 的 `scripts`、`engines`、`type`（`module` 表示 ESM）和 `packageManager`，**优先用项目已有的脚本**（`test`、`lint`、`typecheck`、`build`），不要绕过去直接调底层命令，除非脚本不存在。
- 看 `tsconfig.json`（及它 `extends` 的文件）：`strict`、`module`、`moduleResolution`、`paths`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`。改代码要遵守已开的严格选项，不要为了过编译去放宽它们。
- 有多个 tsconfig（`tsconfig.app.json`、`tsconfig.node.json`、`references`）时，用 `tsc -b`，或对对应的配置用 `-p`。

## 验证改动：从快到慢

1. **类型检查**：项目有脚本（`typecheck` / `type-check` / `check`）就用它；否则 `<exec> tsc --noEmit`（有 `references` 用 `tsc -b`；Vue 项目用 `vue-tsc --noEmit`；Svelte 用 `svelte-check`）。
2. **相关测试**：只跑改到的文件，比跑全部快得多。
   - vitest：`<exec> vitest run <路径或名字过滤>`（不带 `run` 会进入监听模式，别用）；单个用例 `-t "<名字>"`。
   - jest：`<exec> jest <路径> -t "<名字>"`。
   - Node 内置：`node --test`；Deno：`deno test`；bun：`bun test`。
   - 认测试框架：看 `package.json` 依赖和 `vitest.config.*` / `jest.config.*` / `vite.config.*` 里的 `test`。
3. **lint**：有 `eslint.config.*` / `.eslintrc*` 用 `<exec> eslint <改到的文件>`；有 `biome.json(c)` 用 `<exec> biome check <路径>`；有 `oxlint` 配置同理。
4. **格式**：有 `.prettierrc*` / `prettier.config.*` 用 `<exec> prettier --check <路径>`（要改写才用 `--write`）；Biome 项目的格式已包含在 `biome check` 里，`biome format --write` 才会改写。**只格式化自己改的文件**，不要全仓库重排。
5. **构建**：改了公共导出、打包配置或类型声明时，再跑项目的 `build` 脚本。

`<exec>` 就是第 1 节表里「一次性执行」那一列。

**Deno 项目没有 `<exec>`，用内置子命令**（`deno run tsc` 是错的，会被当成模块文件）：类型检查 `deno check <入口文件>`（或项目已有的任务），lint `deno lint`，格式 `deno fmt --check <路径>`（要改写才去掉 `--check`），测试 `deno test`。先看 `deno.json` 的 `tasks`，有现成任务就用任务。

## Monorepo

- 有 `pnpm-workspace.yaml`、`package.json` 的 `workspaces`、`turbo.json`、`nx.json`、`lerna.json` 就是 monorepo。先确认你改的文件属于哪个包，在那个包里跑脚本。
- 只跑受影响的包：pnpm 用 `pnpm --filter <包名> run <脚本>`；npm 用 `npm run <脚本> -w <包名>`；yarn Berry 用 `yarn workspace <包名> <脚本>`；有 turbo 用 `turbo run <任务> --filter=<包名>`。
- 包之间互相依赖时，被依赖的包可能要先构建，类型才找得到。看到「找不到模块 / 声明文件」先确认这一点，不要急着改类型。
- 不要在子包里单独 `install` 或升级共享依赖版本。

## 常见坑

- ESM / CJS：`"type": "module"` 下相对导入在 Node 里要写扩展名（`./a.js`，即使源码是 `a.ts`），除非项目用打包器或 `moduleResolution: bundler`。照项目现有写法来。
- `import type` / `verbatimModuleSyntax`：只当类型用的导入要写 `import type`，项目开了这个选项时不写会报错。
- 不要用 `any` 或 `@ts-ignore` 糊过去；确实要压制时用 `// @ts-expect-error <原因>`，并保持窄范围。优先 `unknown` + 收窄，或 zod 之类项目已有的校验库。
- 不要用 `as` 断言掩盖真实的类型问题；先看是不是数据形状本来就不对。
- 索引访问（`arr[i]`、`obj[key]`）在开了 `noUncheckedIndexedAccess` 时可能是 `undefined`，要处理。
- 改了 `.d.ts`、`tsconfig`、路径别名后，编辑器的报错可能是缓存，以命令行 `tsc` 的结果为准。
- 异步：不要漏 `await`；`forEach` 里放 `async` 回调不会被等待，用 `for...of` 或 `Promise.all`。
- 测试里用假定时器后要还原（`vi.useRealTimers()` / `jest.useRealTimers()`），避免影响别的用例。

## 交付前

- 把类型检查、相关测试、lint 的结果（通过 / 失败、失败的第一条报错）告诉用户；没跑过的要明说，不要声称已验证。
- 没有测试脚本或工具没装时，如实说明，不要自己装。
