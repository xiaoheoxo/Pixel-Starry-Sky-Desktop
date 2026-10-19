请为下面的 {{language}} 代码写单元测试，文件是 {{file}}，项目是 {{project}}。

先看项目里已有的测试：用的是哪个测试框架（vitest / jest / node:test / bun test / deno test，看 package.json、deno.json 和配置文件）、测试文件放在哪里、命名规则（`*.test.ts` / `*.spec.ts` / `__tests__`）、有没有现成的 mock 和工具函数，然后沿用同样的写法，不要引入新的测试库。

要求：
- 覆盖正常路径、边界值（空值、0、空数组、超长输入）和出错路径；异步代码用 async/await，错误用 `rejects` / `toThrow` 断言。
- 每个用例只验证一件事，用例名描述行为。
- 外部依赖（网络、文件、时间）用 mock 或假定时器隔离，并在用例后还原。
- 写完告诉我怎么只运行这些测试（用项目自己的包管理器和脚本），不要擅自安装依赖。

代码：

```
{{selection}}
```
