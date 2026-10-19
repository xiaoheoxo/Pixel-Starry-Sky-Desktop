---
name: python-project
description: 在 Python 项目里写代码、跑测试、修报错、装依赖时使用，先认出项目用的工具链再动手。Use when working in a Python project: detect uv / Poetry / PDM / pip tooling, run pytest, ruff, mypy and fix tracebacks without switching tools.
---

# Python 项目工作流

## 原则

- 先看项目里已有的配置和锁文件，**用项目自己的工具**；不擅自换工具，不擅自加依赖，不擅自升级依赖或改 Python 版本。
- 需要新依赖时先说明理由并征得同意，再用项目的包管理器添加（不要直接手改锁文件，也不要用裸 `pip install` 装进系统环境）。
- 不要把虚拟环境目录（`.venv/`、`venv/`）、`__pycache__/`、`.pytest_cache/`、`.mypy_cache/`、`.ruff_cache/` 提交进版本库。

## 认工具链

按下面的线索判断，找到第一个对得上的就用它：

| 线索 | 工具 | 常用命令 |
| --- | --- | --- |
| `uv.lock` | uv | `uv sync`、`uv run pytest`、`uv add 包名`、`uv lock` |
| `poetry.lock`，或 `pyproject.toml` 里有 `[tool.poetry]` | Poetry | `poetry install`、`poetry run pytest`、`poetry add 包名` |
| `pdm.lock`，或 `[tool.pdm]` | PDM | `pdm install`、`pdm run pytest`、`pdm add 包名` |
| `Pipfile` / `Pipfile.lock` | Pipenv | `pipenv install --dev`、`pipenv run pytest` |
| 只有 `requirements*.txt` | pip + venv | 先激活项目的虚拟环境，再 `python -m pip install -r requirements.txt`、`python -m pytest` |
| `tox.ini` | tox | `tox -e 环境名`（`tox list` 看有哪些） |
| `noxfile.py` | nox | `nox -s 会话名`（`nox -l` 看有哪些） |
| `[tool.poe.tasks]` | Poe the Poet | `poe 任务名` |
| `[tool.pdm.scripts]` | PDM 脚本 | `pdm run 脚本名` |

项目有 `.python-version`、`requires-python` 或 CI 里写明了 Python 版本，就按它来，不要用更新的语法特性（比如项目支持 3.9 时不写 `match` 和 `X | Y` 注解）。

## 验证改动

改完代码按项目已配置的检查，先快后慢，只跑项目里有的：

1. 格式化 / 检查：有 Ruff 就 `ruff check .` 和 `ruff format .`（前面按项目工具加 `uv run` / `poetry run` / `pdm run`）；用 Black、flake8、isort 的项目就用它们自己的命令，不要改用 Ruff。
2. 类型检查：有 mypy 配置就 `mypy .`（或项目 CI 里写的路径），用 pyright 就 `pyright`。
3. 测试：`pytest`。只改了一处时先跑相关文件 `pytest tests/test_x.py -q`，用 `-k 关键字` 选单个测试，`-x` 遇到第一个失败就停，`--lf` 只重跑上次失败的；最后再跑一遍完整测试。
4. 看 `pyproject.toml` 的 `[tool.pytest.ini_options]`、`tox.ini`、`noxfile.py` 或 CI 配置，确认项目实际用的参数，和它们保持一致。

## 修报错

- 读 Traceback 先看**最后一行**的异常类型和信息，再从下往上找第一个属于项目自己代码的帧；框架内部的帧通常只是调用路径。
- `ModuleNotFoundError` / `ImportError`：先确认是不是在项目的虚拟环境里运行（用 `uv run`、`poetry run` 等），再检查是不是缺依赖或包名与导入名不同；不要上来就 `pip install`。
- 循环导入：把共用的类型或函数挪到第三个模块，或把导入移到函数内；类型注解专用的导入放进 `if TYPE_CHECKING:`。
- 可变默认参数（`def f(x=[])`）、闭包里的循环变量、在迭代时修改列表或字典，都是常见的隐蔽错误。
- 异步代码里不要调用会阻塞的同步函数（`time.sleep`、`requests`）；`asyncio.run` 不能在已有事件循环里再调用。

## 写测试

- 沿用项目已有的测试目录结构、命名（`test_*.py`、`test_` 开头的函数）和 `conftest.py` 里的 fixture。
- 用 `pytest.mark.parametrize` 覆盖多组输入，用 `tmp_path` 处理临时文件，用 `monkeypatch` 改环境变量和属性；只替换网络、时间、文件系统这类外部依赖。
- 要断言异常用 `pytest.raises(类型, match=...)`。

## 常见坑

- 写文件、读文件显式指定 `encoding="utf-8"`，路径用 `pathlib.Path`，不要拼字符串。
- Windows 上路径分隔符、换行和 `subprocess` 的 shell 行为不同，调用外部命令用列表形式的参数，不要拼字符串。
- 项目是 `src/` 布局时，包要通过 `uv sync` / `poetry install` 之类安装后才能被测试导入，别用改 `sys.path` 绕过去。
- 依赖放在 `pyproject.toml` 里管理的项目，不要再另外生成 `requirements.txt` 来取代它。
