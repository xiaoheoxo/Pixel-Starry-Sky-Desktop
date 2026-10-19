# 官方语言扩展制作约定

一种语言一个扩展，发布者 `pixelsky`，放在 `extensions/official/<名字>/`。规划见 `docs/ui/official-language-extensions.md`，通用格式见 `docs/extensions/authoring-spec.md`。**本文写的是软件代码实际执行的规则**，和规范不一致的地方以本文为准（2026-10-17 对照代码核过）。

## 1. 每个扩展的文件

```
extensions/official/python/
  pixelsky-extension.json     清单
  README.md                   中文说明（详情页显示）
  LICENSE                     本扩展 MIT 全文；用了上游语法时，后面附上游的版权声明和许可证全文
  CHANGELOG.md                「## 1.0.0」+ 一句话
  icon.png                    由 scripts/make-icons.mjs 生成，不要手改
  snippets/<语言 id>.json     片段，每个文件对应一个语言 id
  skills/<技能名>/SKILL.md    技能
  prompts/<id>.md             提示词
  syntaxes/*.tmLanguage.json  （只有带语法的扩展）
  language-configuration.json （只有带语法的扩展）
  samples/                    （只有带语法的扩展）语法测速用的示例
  SOURCE.md                   （只有带上游文件的扩展）每个上游文件的来源地址、提交号、许可证
  .fixtures/<场景>/           任务模板的验收用例（以 . 开头，不进包，见 §5）
```

## 2. 清单

```json
{
  "id": "pixelsky.python",
  "name": "Python 支持",
  "version": "1.0.0",
  "publisher": "pixelsky",
  "description": "Python 的代码片段、uv / Poetry / tox / nox 任务、写测试和查类型的技能与提示词",
  "icon": "icon.png",
  "keywords": ["python", "pytest", "uv"],
  "license": "MIT",
  "repository": "https://github.com/xiaoheoxo/Pixel-Starry-Sky-Desktop",
  "homepage": null,
  "engines": { "pixelsky": ">=0.4.10" },
  "l10n": { "en": { "name": "Python Support", "description": "…" } },
  "contributes": { },
  "main": null,
  "permissions": [],
  "price": null
}
```

- `name` ≤ 40 字（按 UTF-16 算），**不能含「官方」「像素星空」**，写「X 支持」；`description` ≤ 120；`l10n.en.name` ≤ 40、`description` ≤ 160；`keywords` ≤ 10 个、每个 ≤ 20 字、不重复。
- `engines.pixelsky` 统一写 `>=0.4.10`（软件比较时忽略 `-beta`，`>=0.5.0` 会让现在的开发版不加载）。
- 不认识的字段会被拒；不要写 `$schema`、`categories`。
- 显示给人看的文字（任务 `label` / `description`、提示词 `title` / `description`）一律写 `{ "zh": "…", "en": "…" }`。

## 3. 各种贡献的实际规则

### 3.1 片段 `snippets`

- `language` **必须是软件认得的语言 id**，写错（`py`、`bash`、`cs`、`c#`）校验器不报错，但永远不生效：
  `python` `typescript` `typescriptreact` `javascript` `javascriptreact` `go` `rust` `java` `kotlin` `c` `cpp` `csharp` `shellscript` `json` `yaml` `toml`。注意 `.h` 文件是 `c`，不是 `cpp`。
- 片段自己写，不从别处拷（省去许可问题）。每门 20–40 条，写真正常用、地道的写法；片段名（键）用中文，`description` 中文。
- `prefix` 每个 ≤ 30 字、`body` 非空；`$` 要写成 `\\$`；支持 `$1` `${1:默认}` `${1|a,b|}` `$0` 和 `$TM_FILENAME_BASE` 等（见规范 §6）。
- 不要和内置补全打架：前缀用简短英文（`main`、`test`、`fn`…），不要用单个字母。

### 3.2 任务模板 `taskTemplates`

- `files` **只能写精确文件名**（区分大小写，不能写 `*.csproj`、不能带路径）；软件只找根目录往下 3 层、全部模板合计最多 30 个文件；跳过 `.` 开头的目录和 `node_modules .git dist build out target vendor`。
- **不能用**：`package.json`、`Makefile`/`makefile`/`GNUmakefile`、`Cargo.toml`、`build.gradle(.kts)`、`settings.gradle(.kts)`（内置已认）；`id` 不能是 `npm` `make` `cargo` `gradle`。
- `id`：`^[a-z0-9][a-z0-9-]*$`，≤ 48，包内唯一。
- 任务名 `^[A-Za-z0-9_][A-Za-z0-9_.:@/+=-]{0,79}$`：**不能有空格**；带参数的写进 `command`，不同命令形状就分成不同模板（如 `go {name} ./...` 和 `go mod {name}`）。`command` 里可以不用 `{name}`（只有一个任务时，如 `go run .`）。
- `command` 第一个词必须是固定文字或 `{runner}`；占位符只有 `{name}` `{runner}` `{dir}` `{file}`，其他花括号一律不行。
- `runner` 是**单个程序**（`uv`，不能写 `uv run`；子命令写进 `command`：`{runner} run {name}`）。`windows` / `default` 分平台；`when` 不成立且写了 `fallback` 才用 `fallback`。项目里的文件（`./mvnw`）软件会自动加 `./` / `.\` 和 PowerShell 的 `&`。
- `when` 只能一个条件：`contains:文字`（构建文件全文里有这段，区分大小写）、`exists:同目录文件名`，可加 `!`。**任务级 `when` 和 `runner.when` 都是对「被认出的那个文件」求值**——想按另一个文件判断就用 `exists:`。
- `extract`：JavaScript 正则，flags 只能是 `g m i u`；软件强制加 `g`、200 ms 超时、每条最多 200 个匹配、只读前 1 MB；允许前瞻 / 后顾，禁止嵌套量词（`(a+)+`）。取 TOML 某张表里的键可以用后顾：`^(?<=\\[tool\\.pdm\\.scripts\\][^\\[]*?)([A-Za-z0-9_-]+)[ \\t]*=`，但要在 README 的「已知问题」里写明局限（表里的值含 `[` 时后面的键取不到）。
- `description` 用 `{ "commentBefore": "#" }` 时只看紧挨着的上一行。
- `cwd` 默认 `{dir}`（构建文件所在文件夹）；命令里用了 `{dir}` 时把 `cwd` 设成 `"."`，免得进两次目录。
- 子目录里的构建文件各自成一组；同名任务先出现的胜出（固定 `tasks` 在 `extract` 前面）。

### 3.3 技能 `skills`

- `SKILL.md` 开头的 frontmatter **每个键只能写一行**（`description: >` 多行写法会被读成 `>`）；键名小写；不要 BOM。
- `name`：`^[a-z0-9-]{1,64}$`，**要独特**：Codex 那边不加前缀，和用户自己的技能同名会撞。统一叫 `<语言>-project`（如 `python-project`）；Claude 那边会显示成 `/ext-pixelsky-python:python-project`。
- `description` ≤ 1024，写清**什么时候用**，中英文触发词都写（「在 Python 项目里写代码、跑测试、修报错时使用。Use when working in a Python project…」）。
- 文件夹里只能放 `.md` 和图片；可以链接同文件夹里的其他 `.md`。
- 正文中文为主，命令和代码原样；控制在 200 行内。只写**这门语言的项目怎么认工具链、怎么验证改动（测试 / 类型检查 / lint / 格式化的确切命令和先后）、常见坑**，不写入门教程；要求「先看项目里已有的配置和锁文件，用项目自己的工具，不擅自换工具或装新依赖」。
- 对所有引擎都给（不写 `engines`）。

### 3.4 提示词 `prompts`

- `id` `^[a-z0-9][a-z0-9-]*$` ≤ 48；`path` 必须是 `.md`；正文 ≤ 8000 字。
- 占位符只有 `{{selection}}`（选中的代码）、`{{file}}`（文件路径）、`{{language}}`（**显示名**，如 `Python`、`TSX`，不是语言 id）、`{{project}}`（项目名）。
- 选中代码类的写 `"requires": "selection"`、`"where": ["composer", "editor"]`；不需要选中的只放 `composer`。
- 从「/」菜单选会**替换**整个输入框，从编辑器右键选是**追加**；正文写成完整、可直接发送的一段话，中文。
- 每个扩展 3–5 条，和这门语言相关（如 Python：为选中代码写 pytest 测试、补类型注解、补 docstring、解释报错堆栈）。

### 3.5 语法 `grammars`（只有带语法的扩展）

- 用上游开源语法，许可只收 MIT / Apache-2.0 / BSD；在 `SOURCE.md` 写来源地址和提交号，在 `LICENSE` 末尾附上游版权声明和许可证全文，README 写明来源。
- `language` 用 VS Code 的 id（和内置相同的 `java` `c` `cpp` `csharp` `kotlin`）；和内置相同时**默认仍用内置高亮**，用户在扩展详情里打开「用这个扩展代替内置高亮」才换（内置有代码折叠，扩展语法没有）——README 要写这一点。
- `scopeName` 只能小写、数字、`.+-`；必须和语法文件里一致；语法文件严格 JSON、≤ 2 MB。
- `samples/` 下每个语法至少一个 ≥ 30 行的示例（自己写，覆盖注释、字符串、数字、关键字、函数、类型…），合计 ≤ 200 KB；必须过测速（单行 ≤ 30 ms、5000 行 ≤ 1 s）。过不了就不放这个语法，在 README 里说明。
- `language-configuration.json` 实际生效的只有 `comments`、`autoClosingPairs`（只认 `open`/`close`）、`indentationRules`；`brackets` `surroundingPairs` `wordPattern` 照常写上，以后会生效。

## 4. README 结构（中文）

```
# Python 支持

一句话说明。

## 装上以后
- **代码片段**：前缀一览（表格：前缀 / 作用）
- **任务**：认哪些文件、列出哪些任务、各用什么命令
- **技能**：`python-project`，Claude Code 里是 `/ext-pixelsky-python:python-project`，Codex 里是 `$python-project`；做什么
- **提示词**：输入框「/」菜单和编辑器右键里有哪几条
- **语法高亮**（如有）：默认仍用内置高亮，怎么切换

## 已知问题
## 来源和许可证
```

不夸大、不放推广链接。

## 5. 验收

1. **上传标准检查**：`pnpm ext validate extensions/official/<名字>`（默认就是上传档、完整语法检查），必须零错误零警告（`files.unused` 这种 hint 可以有）。
2. **任务用例**：每个任务模板至少一个 `.fixtures/<场景>/` 用例：放真实样子的构建文件（`pyproject.toml`、`uv.lock`…，内容精简但要像真的），加一个 `expected.json`：

```json
[
  {
    "template": "uv",
    "file": "pyproject.toml",
    "tasks": [
      { "name": "pytest", "description": "运行测试", "linux": "uv run pytest", "windows": "uv run pytest" }
    ]
  }
]
```

   - 数组按软件列出的顺序：文件按「目录广度优先、同目录按名字排序」，同一个文件按清单里模板的顺序；没列出任务的模板不出现。
   - `description` 写中文（`zh`）那份，没有描述就省掉这个键。
   - `linux` 是在 Linux 上用 bash 运行的完整命令，`windows` 是在 Windows 上用 PowerShell 运行的完整命令（都包括 `cd` 部分），子目录里的用例要覆盖。
   - 要有反例场景（比如没有 `uv.lock` 时不该出 uv 组），`expected.json` 写 `[]`。
   - 跑：`pnpm --filter @pixelsky/desktop exec vitest run src/main/extension-packs/official.test.ts --root .`（`OFFICIAL_EXT=python` 只跑一个）。这个测试还会按软件的加载器加载扩展，要求零错误。
3. **片段、技能、提示词**：校验之外，自己通读一遍：片段能展开成正确代码、技能里的命令真实存在且参数对、提示词能直接发送。
