# Kotlin 支持

Kotlin 的语法高亮、代码片段，以及在 Gradle 项目里写代码、跑测试的技能和提示词。

## 装上以后

- **代码片段**：`.kt` / `.kts` 文件里输入前缀即可展开，常用的有：

  | 前缀 | 作用 |
  | --- | --- |
  | `main` | main 函数 |
  | `data` / `sealed` / `sealedi` | data class / 密封类 / 密封接口 |
  | `when` / `whenis` | when 表达式 / 按类型分支的 when |
  | `extfun` / `extprop` | 扩展函数 / 扩展属性 |
  | `suspend` / `launch` / `async` / `parallel` | 挂起函数 / 启动协程 / async-await / 并行汇总 |
  | `runblocking` / `withctx` | runBlocking / 切换调度器 |
  | `flow` / `collect` / `stateflow` | Flow 构建 / 收集 / StateFlow |
  | `test` / `testclass` / `runtest` / `assertthrows` | kotlin.test 测试 / JUnit 5 测试类 / 协程测试 / 断言抛异常 |
  | `elvis` / `elvisret` / `letnn` | 空安全默认值 / 为空提前返回 / 非空才执行 |
  | `require` / `check` | 参数检查 / 状态检查 |
  | `apply` / `use` / `lazy` | 配置对象 / 自动关闭资源 / by lazy |
  | `object` / `companion` / `valueclass` | 单例 / 伴生对象 / 值类 |
  | `chain` / `try` | filter-map 链 / try-catch |

- **任务**：不提供。Gradle（`build.gradle(.kts)`、`settings.gradle(.kts)`）软件已内置识别，Kotlin 项目的 Gradle 任务直接就能列出；Maven 项目的 `pom.xml` 不属于本扩展。
- **技能**：`kotlin-project`，Claude Code 里是 `/ext-pixelsky-kotlin:kotlin-project`，Codex 里是 `$kotlin-project`。教 AI 先认项目（Gradle wrapper、JVM / Android / 多平台）、用项目自己的工具，并按「编译、受影响的测试、全量构建、已配置的 ktlint / detekt」的顺序验证改动，不擅自换工具或加依赖。
- **提示词**：输入框「/」菜单和编辑器右键里有三条针对选中代码的：为选中代码写 Kotlin 测试、改写成地道的 Kotlin、改成协程 / Flow 写法；输入框里另有一条：排查 Gradle / 编译报错。
- **语法高亮**：语言 id 为 `kotlin`，识别 `.kt`、`.kts`。软件内置了 Kotlin 高亮，装上本扩展后**默认仍用内置高亮**；想换成本扩展的语法，到扩展详情里打开「用这个扩展代替内置高亮」。内置高亮有代码折叠，扩展语法没有。

## 已知问题

- 扩展语法是基于正则的 TextMate 语法，一些边角写法（复杂的泛型嵌套、字符串模板里再嵌多层字符串）高亮可能不准。
- 语法不带代码折叠。

## 来源和许可证

本扩展以 MIT 许可发布。语法文件来自 [nishtahir/language-kotlin](https://github.com/nishtahir/language-kotlin)（Apache-2.0，提交 a4c6c66），其上游版权声明和许可证全文附在 LICENSE 末尾，来源明细见 SOURCE.md。片段、技能、提示词和示例为本项目自己编写。
