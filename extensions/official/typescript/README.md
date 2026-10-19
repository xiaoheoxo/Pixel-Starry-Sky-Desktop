# TypeScript / JavaScript 支持

TypeScript、JavaScript（含 React 的 TSX / JSX）的常用代码片段，Deno 任务，以及写测试、补类型、认工具链的技能和提示词。

## 装上以后

- **代码片段**：`typescript`、`typescriptreact`、`javascript`、`javascriptreact` 四种语言各一份，JS 版本不带类型。

| 前缀 | 作用 | 适用 |
| --- | --- | --- |
| `afn` / `arrfn` | 异步函数 / const 箭头函数 | 全部 |
| `trycatch` | try / catch / finally | 全部 |
| `fetchjson` | 带 AbortController 超时、检查 `res.ok` 的 fetch JSON | 全部 |
| `descr` / `itt` / `ita` / `iteach` | describe / it / 异步 it / it.each 表格测试 | 全部 |
| `vitest` / `vimock` | 导入 vitest 的测试函数 / `vi.mock` 模块 | 全部 |
| `sleepfn` / `debouncefn` / `retryfn` | 等待 / 防抖 / 指数退避重试 | 全部 |
| `promall` / `promsettled` | `Promise.all` / `Promise.allSettled` | 全部 |
| `forof` / `cls` | `entries()` 遍历 / 带构造函数的类 | 全部 |
| `jsonparse` / `nmain` / `reqenv` | 安全解析 JSON / Node 入口 main / 必填环境变量 | 全部 |
| `doc` | JSDoc / TSDoc 注释 | 全部 |
| `zodschema` | zod 对象模式（TS 版同时生成 `z.infer` 类型） | 全部 |
| `intf` / `typ` | interface / type 别名 | TS、TSX |
| `dunion` / `exhaust` / `assertnever` | 可辨识联合 / 用 `never` 穷尽检查的 switch / assertNever | TS、TSX |
| `isguard` / `assertfn` | 类型守卫 / asserts 断言函数 | TS、TSX |
| `resulttype` / `constsat` / `constenum` | Result 类型 / `as const satisfies` / const 对象代替枚举 | TS、TSX |
| `rfc` | 函数组件 | TSX、JSX |
| `us` / `ue` / `ucb` / `ur` | useState / useEffect（带清理）/ useCallback / useRef | TSX、JSX |
| `ctx` / `uhook` | Context + Provider + hook / 自定义 hook | TSX、JSX |

- **任务**：认 `deno.json`、`deno.jsonc`，把顶层 `tasks` 里的每个任务列出来，用 `deno task <名字>` 运行。`package.json` 的脚本由软件内置的 npm 任务处理，本扩展不重复。
- **技能**：`typescript-project`，Claude Code 里是 `/ext-pixelsky-typescript:typescript-project`，Codex 里是 `$typescript-project`。教 AI 按锁文件认包管理器（pnpm / yarn / npm / bun / deno），用项目自己的脚本做类型检查、测试、lint、格式化，了解 monorepo 的跑法，并且不擅自换工具或装新依赖。
- **提示词**：输入框「/」菜单和编辑器右键里有「为选中代码写测试」「为选中代码补类型」「把选中的 JS 改成 TS」；输入框「/」菜单里还有「解释 TypeScript 编译错误」。

## 已知问题

- Deno 任务靠正则从 `deno.json(c)` 里找 `tasks` 的键名，不是完整的 JSON 解析：
  - 任务名只认字母、数字和 `_ . : @ / + = -`。
  - `tasks` 里写成对象形式的任务（`{ "command": …, "dependencies": […] }`）最多支持 4 个；超过 4 个对象形式的任务后，后面的任务不会列出。
  - 对象形式任务里再嵌套一层对象、`tasks` 里出现 `//` 注释且注释含 `{` `}` 时，结果可能不准；被 `//` 注释掉的整行任务会被跳过，`/* */` 块注释里的任务名仍可能被列出。
  - 任务没有描述；`deno.json` 里没有 `tasks` 时不出现 Deno 分组。
- 片段里的 vitest / jest 写法是通用的，用 jest 的项目不要用 `vitest` 和 `vimock` 这两个。
- Bun 和 npm / pnpm / yarn 项目的脚本由内置任务列出，本扩展没有对应任务。

## 来源和许可证

片段、任务模板、技能和提示词均由像素星空编写，MIT 许可证，见 LICENSE。
