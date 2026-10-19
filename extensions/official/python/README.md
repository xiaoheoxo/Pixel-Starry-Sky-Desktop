# Python 支持

Python 项目的代码片段、常见工具链的任务，以及写测试、补类型、查报错的技能和提示词。

## 装上以后

- **代码片段**：在 `.py` 文件里输入前缀后补全。

  | 前缀 | 作用 |
  | --- | --- |
  | `main` / `mainfn` / `asyncmain` | 入口守卫 / 带返回码的 main / asyncio 入口 |
  | `def` / `adef` | 带类型注解和 docstring 的函数 / 异步函数 |
  | `class` / `dataclass` / `prop` / `enum` / `exc` | 类 / 数据类 / 属性 / 枚举 / 自定义异常 |
  | `protocol` / `typeddict` / `typecheck` | Protocol / TypedDict / `TYPE_CHECKING` 导入 |
  | `test` / `fixture` / `fixtureyield` / `parametrize` / `raises` / `skipif` / `patch` | pytest 测试、fixture、参数化、断言异常、条件跳过、mock |
  | `ctxmgr` / `ctxclass` | 上下文管理器（函数 / 类） |
  | `try` | try / except / else / finally |
  | `logging` / `logger` | logging 基本配置 / 模块级 logger |
  | `argparse` | 命令行参数解析 |
  | `readfile` / `writefile` / `jsonfile` | pathlib 读写文本、读写 JSON |
  | `fdebug` / `lcomp` / `dcomp` / `cache` | f-string 调试、推导式、`functools.cache` |

- **任务**：代码模式的「任务」视图认下面这些文件，命令在文件所在文件夹里运行。

  | 文件 | 列出的任务 | 命令 |
  | --- | --- | --- |
  | `uv.lock` | sync、lock | `uv sync`、`uv lock` |
  | `uv.lock` | pytest、pyright（锁文件里有这个包才列） | `uv run pytest` 等 |
  | `uv.lock` | mypy（锁文件里有 mypy 才列） | `uv run mypy .` |
  | `uv.lock` | check、format（锁文件里有 ruff 才列） | `uv run ruff check .`、`uv run ruff format .` |
  | `poetry.lock` | install、lock、build | `poetry install` 等 |
  | `poetry.lock` | pytest（锁文件里有 pytest 才列） | `poetry run pytest` |
  | `pyproject.toml` | `[tool.pdm.scripts]` 里的脚本 | `pdm run 脚本名` |
  | `pyproject.toml` | `[tool.poe.tasks]` 里的任务 | `poe 任务名` |
  | `tox.ini` | `[testenv:名字]` 和 `env_list` 里列出的环境 | `tox -e 名字` |
  | `noxfile.py` | 带 `@nox.session` 的函数（或 `name=` 指定的名字） | `nox -s 名字` |
  | `Pipfile` | `[scripts]` 里的脚本 | `pipenv run 脚本名` |

- **技能**：`python-project`，Claude Code 里是 `/ext-pixelsky-python:python-project`，Codex 里是 `$python-project`。教 AI 先认出项目用的是 uv、Poetry、PDM 还是 pip，再用项目自己的工具跑 pytest、Ruff、mypy，不擅自换工具、不擅自加依赖。
- **提示词**：输入框「/」菜单和编辑器右键（选中代码时）里有「为选中代码写 pytest 测试」「补全类型注解」「补全 docstring」；「解释报错堆栈」只在输入框「/」菜单里，选中后把报错堆栈贴在同一条消息里发出（没贴的话 AI 会先问你要）。

## 已知问题

- 任务只按文件内容读取，不会真的运行工具确认；`uv run pytest` 这类任务是否可用取决于项目里装了没有，所以只在 `uv.lock` / `poetry.lock` 里能找到对应包时才列出。
- PDM 脚本、Poe 任务、Pipfile 脚本是用正则读 TOML 的：表里某个键的值含 `[`（比如 `composite = ["a", "b"]`）时，它后面的键读不到。Poe 的 `[tool.poe.tasks.名字]` 子表写法可以读到。PDM 的 `pre_*` / `post_*` 钩子脚本也会被列出来。
- tox 只读单行的 `env_list = a, b, c`（和 tox 3 的 `envlist`），分成多行的写法和 `py{311,312}` 这样的因子展开读不到；`[testenv:名字]` 的名字里带花括号时也读不到。
- nox 只认紧挨着函数的 `@nox.session` 装饰器，以及它和函数之间隔一行装饰器（如 `@nox.parametrize(...)`，只能写在一行里）的写法；会话用 `name="..."` 改名时列出的是改后的名字。
- PDM 和 Poe 的 `名字.cmd = ...` 点号写法、PDM 的 `[tool.pdm.scripts.名字]` 子表都能读到。tox 4 里只写版本号的环境（如 `3.13`）也会列出；`{...}` 因子展开读不到。
- nox 装饰器参数里带括号（如 `python=get_versions()`）的会话读不到。
- `poe`、`tox`、`nox`、`pdm`、`pipenv` 命令要在 PATH 里（用 pipx / `uv tool install` 装好，或先激活虚拟环境）；装在项目 `.venv` 里没激活时会提示找不到命令。
- 同一个 `pyproject.toml` 同时有 PDM 和 Poe 配置时两组都会出现。
- 子目录最多往下找 3 层；`.venv`、`node_modules` 等目录会被跳过。

## 来源和许可证

代码片段、技能和提示词均为原创，使用 MIT 许可证，全文见 LICENSE。没有使用任何上游语法或第三方文件。
