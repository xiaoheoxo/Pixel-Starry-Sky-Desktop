请给下面的 {{language}} 代码补全或收紧类型，文件是 {{file}}，项目是 {{project}}。

要求：
- 先看项目的 tsconfig（`strict`、`noUncheckedIndexedAccess` 等）和已有的类型定义，沿用项目的命名和风格。
- 不使用 `any`；不确定的输入用 `unknown` 再收窄，对象形状用 `interface` / `type`，需要时用泛型、联合类型、`as const`、`satisfies`。
- 不用 `as` 断言掩盖问题；如果发现类型和实际数据对不上，指出来，不要悄悄改运行时行为。
- 只改类型，不改逻辑；改完说明每处类型是怎么定的，以及怎么用 `tsc --noEmit`（或项目的类型检查脚本）验证。

代码：

```
{{selection}}
```
