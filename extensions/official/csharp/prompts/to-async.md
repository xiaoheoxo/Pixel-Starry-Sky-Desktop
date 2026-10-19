请把下面这段 C# 代码改成基于 Task 的 async/await 写法。

文件：{{file}}

```
{{selection}}
```

要求：
1. 方法名加 Async 后缀，返回 Task 或 Task<T>（热路径上确实有收益时才用 ValueTask）；不要写 async void（事件处理器除外）。
2. 公开方法增加 CancellationToken cancellationToken = default 参数，并传给内部所有支持它的异步调用。
3. 不要用 .Result、.Wait()、GetAwaiter().GetResult() 阻塞；能并行的独立调用用 Task.WhenAll，不要把同步代码包进 Task.Run 冒充异步。
4. 资源用 await using；类库代码按项目现有习惯决定是否加 ConfigureAwait(false)。
5. 列出调用方需要同步修改的地方，并用 dotnet build 确认能编译。
