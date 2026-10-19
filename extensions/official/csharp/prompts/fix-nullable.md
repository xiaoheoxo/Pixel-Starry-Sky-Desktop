请处理下面这段 C# 代码里的 nullable 警告（CS8600 到 CS8604、CS8618、CS8625 这类）。

文件：{{file}}

```
{{selection}}
```

要求：
1. 先确认项目启用了 Nullable，并用 dotnet build 看看这段代码实际报了哪些警告。
2. 从根上修：让类型如实表达是否可空（string?）、在入口处检查参数（ArgumentNullException.ThrowIfNull）、在构造函数里初始化或使用 required、在调用处判空。
3. 不要用 ! 运算符、#pragma warning disable 或 NoWarn 压警告；确实非空又无法让编译器知道时，用 [NotNull]、[MemberNotNull] 这类特性，或写清楚理由。
4. 不要改动公开 API 的含义；如果必须把参数或返回值改成可空，列出受影响的调用处。
5. 改完再 dotnet build，确认警告减少且没有新增。
