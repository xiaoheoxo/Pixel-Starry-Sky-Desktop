请给下面这段 {{language}} 代码补全类型注解，代码在 {{file}}：

```
{{selection}}
```

要求：
1. 只加注解，不改变运行行为，不改函数逻辑和命名。
2. 先看项目支持的 Python 版本（pyproject.toml 里的 `requires-python`）：3.10 及以上用 `X | None` 和 `list[str]` 这类内置泛型写法，更低的版本才用 `typing` 里的 `Optional`、`List`。
3. 参数和返回值都要写；能用 `collections.abc` 里的抽象类型（`Sequence`、`Mapping`、`Iterator`）表达输入就不要写死成 `list` / `dict`；尽量不用 `Any`，用了要说明原因。
4. 项目里如果配置了 mypy 或 pyright，改完用项目已有的命令检查一遍，并报告结果；不要新增类型检查工具。
