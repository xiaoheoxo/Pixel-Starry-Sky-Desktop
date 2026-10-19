---
name: csharp-project
description: 在 C# / .NET 项目里写代码、跑测试、改构建配置、处理 nullable 警告时使用。Use when working in a C# or .NET project (dotnet CLI, solution/csproj, xUnit/NUnit/MSTest, nullable warnings, NuGet).
---

# C# / .NET 项目工作约定

## 先认清项目，再动手

1. 看根目录和上层目录有什么：`*.sln` / `*.slnx`（解决方案）、`*.csproj`、`global.json`（锁 SDK 版本）、`Directory.Build.props`（全项目共用的编译设置）、`Directory.Packages.props`（集中管理包版本）、`nuget.config`、`.editorconfig`。
2. 用 `dotnet --info` 看当前 SDK；有 `global.json` 时以它为准，不要为了让编译通过去改 SDK 版本。
3. 看 `TargetFramework`（`net8.0`、`net9.0`、`netstandard2.0`…）再决定能用哪些语法和 API，不要在 `netstandard2.0` 项目里用新 BCL 方法，也不要擅自提高目标框架或 `LangVersion`。
4. 用项目已经在用的工具、包和写法。**不擅自换工具、不装新依赖**：需要新包先说明理由，再用 `dotnet add <项目> package <名字>`（启用了集中管理时，版本写进 `Directory.Packages.props`，csproj 里的 `PackageReference` 不带 `Version`）。

## 解决方案还是项目文件

- 一个目录里同时有多个 `.sln` / `.csproj` 时，`dotnet build` / `dotnet test` 会报"找到多个项目或解决方案文件"（MSB1011），必须显式指定：`dotnet build MyApp.sln`、`dotnet test tests/MyApp.Tests/MyApp.Tests.csproj`。
- 日常验证：改动小就只对相关项目跑；改了公共库就对整个解决方案跑。
- `dotnet new sln` 在较新的 SDK 里默认生成 `.slnx`；项目已经是 `.sln` 就保持 `.sln`，不要顺手迁移格式。加项目用 `dotnet sln add <csproj>`，加引用用 `dotnet add <csproj> reference <csproj>`。

## 验证改动的顺序

```
dotnet restore                      # 项目有 packages.lock.json 时用 --locked-mode，别让它悄悄改锁文件
dotnet build --no-restore           # 看编译错误和警告
dotnet test --no-build              # 前面 build 过同一配置才能加 --no-build
dotnet format --verify-no-changes   # 只检查格式，不改文件（需要 .NET 6+ SDK）
```

- 想要的配置不同就带上 `-c Release`（build 和 test 要一致）。
- 只跑一部分测试：`dotnet test --filter "FullyQualifiedName~OrderServiceTests"` 或精确到方法的 `--filter "FullyQualifiedName~OrderServiceTests.Create_ReturnsId"`（`Name=` 只有 NUnit / MSTest 支持，xUnit 不支持，别用它判断测试存不存在）；列出测试：`dotnet test --list-tests`。
- 多目标框架（`TargetFrameworks`）用 `-f net8.0` 指定一个。
- 格式化只在用户要求或项目 CI 要求时才真正改文件（`dotnet format`），否则别整仓库格式化制造大 diff。
- 想看依赖状况：`dotnet list package --outdated`、`dotnet list package --vulnerable`（只看，不自动升级）。

## 测试框架

- 先看测试项目引用了谁：`xunit` / `xunit.v3`、`NUnit`、`MSTest`，**沿用它**，不混用。
- xUnit：`[Fact]`、`[Theory]` + `[InlineData]`；每个测试类的实例是新建的，共享状态用 `IClassFixture<T>`。`Assert.Equal(预期, 实际)`。
- NUnit：`[Test]`、`[TestCase]`；`Assert.That(实际, Is.EqualTo(预期))`。
- MSTest：`[TestMethod]`、`[DataRow]`。
- 异步测试返回 `Task`，不要写 `async void`，不要用 `.Result` / `.Wait()`。
- 新版 SDK 的测试运行器可能是 Microsoft.Testing.Platform（`global.json` 或 csproj 里有相应配置），这时 `--filter` 等参数的写法可能不同，以项目现有的 CI 命令为准。

## nullable 警告（CS86xx / CS8xxx）

- 看项目是否 `<Nullable>enable</Nullable>`（csproj 或 `Directory.Build.props`）。启用了就把警告当真问题处理。
- 修法优先级：改类型让它真实表达可空（`string?`）→ 在入口处检查（`ArgumentNullException.ThrowIfNull`）→ 初始化（构造函数赋值、`required`、`= string.Empty`）→ 调用处判空。
- **不要**用 `!`（null 包容运算符）、`#pragma warning disable` 或 `<NoWarn>` 把警告压掉，除非能说清为什么这里一定非空，并写在注释里。
- 不要为了消除警告而把整个项目的 `Nullable` 关掉。
- 老项目逐文件迁移时，用文件顶部 `#nullable enable`，一次只改一个文件。

## 常见坑

- 异步方法名以 `Async` 结尾，公开 API 带 `CancellationToken`；不要 `async void`（事件处理器除外）。
- 日志用消息模板：`logger.LogInformation("Order {OrderId} saved", id)`，不要用 `$""` 插值拼日志。
- `IDisposable` / `IAsyncDisposable` 用 `using` / `await using`。
- `HttpClient` 用 `IHttpClientFactory` 或长期复用的实例，别在循环里 `new HttpClient()`。
- EF Core 迁移用 `dotnet ef`（需要项目已装 `dotnet-ef` 工具，看 `dotnet-tools.json`）；没有就先问，不要全局安装。
- `bin/` 和 `obj/` 是产物，不要提交，也不要手动改；出现奇怪的编译错误可以先 `dotnet clean` 再编译。
- 改完公开 API 记得同步 XML 文档注释（`///`）和调用方。
