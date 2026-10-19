# C# 支持

给 C#（`.cs`、`.csx`）文件加上语法高亮、常用代码片段、dotnet 任务，以及写测试、处理 nullable 警告的技能和提示词。

## 装上以后

- **代码片段**（语言 `csharp`）：

| 前缀 | 作用 |
| --- | --- |
| `main` / `tlmain` / `webapp` | Main 入口方法 / 顶层语句 / ASP.NET Core 应用骨架 |
| `class` / `sclass` / `interface` / `enum` | 类 / 密封类 / 接口 / 枚举 |
| `record` / `recstruct` | 位置记录 / readonly record struct |
| `prop` / `propi` / `propr` | 属性 get; set; / get; init; / required 属性 |
| `ctor` / `atask` / `extm` | 构造函数 / 异步方法（带 CancellationToken）/ 扩展方法 |
| `xfact` / `xtheory` / `xfacta` | xUnit：Fact / Theory + InlineData / 异步 Fact |
| `ntest` / `ntestcase` | NUnit：Test / TestCase（只在 NUnit 项目里用） |
| `usingb` / `usingd` / `ausing` | using 块 / using 声明 / await using |
| `linq` / `linqq` | LINQ 方法链 / 查询语法 |
| `swe` / `ispat` / `isprop` | switch 表达式 / is 类型模式 / is 属性模式 |
| `logger` / `logi` | 注入 ILogger<T> / 结构化日志调用 |
| `mapget` / `mappost` | Minimal API 的 GET / POST 端点 |
| `nullchk` / `trycatch` / `aforeach` | ArgumentNullException.ThrowIfNull / try catch / await foreach |

- **任务**：认 `global.json`、`Directory.Build.props`、`Directory.Packages.props` 这三种文件，列出 `build`、`test`、`restore`、`format`，分别运行 `dotnet build`、`dotnet test`、`dotnet restore`、`dotnet format`，在该文件所在文件夹执行。
- **技能**：`csharp-project`，Claude Code 里是 `/ext-pixelsky-csharp:csharp-project`，Codex 里是 `$csharp-project`。教 AI 认解决方案和项目文件、用 dotnet CLI 验证改动、沿用项目的测试框架、认真处理 nullable 警告，不擅自换工具或装新依赖。
- **提示词**（输入框「/」菜单；需要选中代码的三条在编辑器右键里也有）：
  - 为选中代码写单元测试（沿用项目现有测试框架）
  - 处理 nullable 警告（不用 `!` 压警告）
  - 解释异常和堆栈（只在输入框）
  - 改成 async/await
- **语法高亮**：默认仍用内置的 C# 高亮（内置有代码折叠）。想换成这个扩展的语法，到 设置 › 扩展 › 已安装 › 本扩展详情里打开「用这个扩展代替内置高亮」；扩展语法没有代码折叠。

## 已知问题

- 任务只能按**精确文件名**识别，软件现在不支持 `*.csproj`、`*.sln` 这类通配符，所以不能"见到项目文件就列任务"。这里改用 `global.json`、`Directory.Build.props`、`Directory.Packages.props` 这三个常放在仓库根目录的文件来触发，有这些局限：
  - 仓库里没有这些文件时，任务视图里什么都没有。
  - 任务直接运行 `dotnet build` 等，不带项目参数：该文件夹里要**恰好有一个** `.sln` / `.slnx` 或 `.csproj`，否则 dotnet 会报"找到多个项目或解决方案文件"，或"找不到项目"。这种情况请在终端里手动指定，例如 `dotnet build MyApp.sln`。
  - `Directory.Build.props` 出现在子文件夹时，也会多出一组任务。
  - 为了减少重复，同一文件夹里有 `global.json` 时不再为 `Directory.Build.props` 另列一组，有 `Directory.Build.props` 时不再为 `Directory.Packages.props` 另列一组；只有 `global.json` 加 `Directory.Packages.props`（没有 `Directory.Build.props`）时，仍会出现两组相同的任务。
  - `dotnet format` 需要 .NET 6 及以上的 SDK。
  - 真正按项目文件识别要等软件支持通配符。
- 扩展语法没有代码折叠，也不会按语义区分类型和变量（TextMate 语法只做词法着色）。
- `.csx` 脚本只有 C# 语法着色，没有别的支持。

## 来源和许可证

语法 `syntaxes/csharp.tmLanguage.json` 来自 microsoft/vscode 的 `extensions/csharp`（由 dotnet/csharp-tmLanguage 转换而来），MIT 许可证，原样未改动；来源地址、提交号见 SOURCE.md，版权声明和许可证全文见 LICENSE 末尾「Third-party notices」。片段、技能、提示词、示例由像素星空编写，MIT 许可证。
