请为 {{file}} 里下面这段 {{language}} 代码补充单元测试（项目：{{project}}）：

```
{{selection}}
```

要求：先看项目里已有的测试写法和依赖（kotlin.test、JUnit 4/5、Kotest、MockK 等），沿用同一套，不要引入新的测试库；测试文件放在对应的 src/test（多平台项目放 commonTest 或对应目标）目录。覆盖正常路径、边界值（空集合、null、空字符串）和异常路径；用到挂起函数时按项目现有方式测（如 kotlinx-coroutines-test 的 runTest），不要用 Thread.sleep。写完后用项目的 Gradle wrapper 运行相关测试（限定到具体模块和任务，例如 ./gradlew :模块名:test --tests "完整类名"；Android 用 :app:testDebugUnitTest，多平台用 :模块名:jvmTest），把结果告诉我；若测试暴露出原代码的问题，先说明再改。
