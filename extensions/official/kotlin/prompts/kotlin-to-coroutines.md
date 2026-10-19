请把 {{file}} 里下面这段 {{language}} 代码改成协程 / Flow 写法：

```
{{selection}}
```

先确认项目已经依赖 kotlinx-coroutines（看 Gradle 构建文件和版本目录）；如果没有，先告诉我，不要擅自添加依赖。改写时遵守结构化并发：不要使用 GlobalScope，协程放在有明确生命周期的作用域里；阻塞的 IO 用 withContext(Dispatchers.IO) 包起来；回调 API 用 suspendCancellableCoroutine 或 callbackFlow 包装并处理取消；不要吞掉 CancellationException；需要并行时用 coroutineScope + async。说明改动后调用方需要怎么调整，并运行项目已有的测试验证。
