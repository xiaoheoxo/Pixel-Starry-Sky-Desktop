请为下面这段 {{language}} 代码写 pytest 测试，代码在 {{file}}（项目 {{project}}）：

```
{{selection}}
```

要求：
1. 先看项目里已有的测试目录、命名方式和 conftest.py 里的 fixture，沿用同样的风格和已有的依赖，不要新装测试库。
2. 覆盖正常路径、边界值和出错路径；输入输出有多组时用 `pytest.mark.parametrize`，需要准备或清理资源时用 fixture（临时文件用 `tmp_path`）。
3. 一个测试只验证一件事，测试名写清楚场景；不要 mock 被测代码本身，只替换网络、时间、文件系统这类外部依赖。
4. 写完后用项目自己的方式运行这些测试（例如 `pytest 测试文件路径`，用 uv 或 Poetry 的项目就加上 `uv run` / `poetry run`），把结果告诉我；如果发现被测代码本身有问题，先说明，不要悄悄改它。
