请把下面的 JavaScript 代码改写成 TypeScript，文件是 {{file}}，项目是 {{project}}。

要求：
- 保持运行时行为完全不变，只加类型；沿用项目的 tsconfig 严格程度和已有类型。
- 参数、返回值和导出都写明类型；对象形状定义成 `interface` / `type`；不使用 `any`，不确定的用 `unknown` 并收窄。
- 只作类型用的导入写成 `import type`（如果项目启用了 `verbatimModuleSyntax` 或 `isolatedModules`）。
- 如果 JS 里有类型不明或可能为 `null` / `undefined` 的地方，列出来让我确认，不要偷偷改逻辑。
- 文件扩展名和相对导入写法遵循项目现有约定；不要新增依赖。

代码：

```
{{selection}}
```
