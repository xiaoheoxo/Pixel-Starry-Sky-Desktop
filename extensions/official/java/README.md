# Java 支持

Java 项目的语法高亮、常用代码片段、Maven 任务，以及写 JUnit 测试、看异常堆栈的技能和提示词。

## 装上以后

- **代码片段**（`.java` 文件里输入前缀，共 32 条）：

| 前缀 | 作用 |
| --- | --- |
| `main` / `classmain` | main 方法 / 带 main 的类 |
| `class` `record` `interface` `enum` `sealed` | 类、记录类、接口、枚举、密封接口（类名默认取文件名） |
| `package` `method` `smethod` `field` `const` `ctor` | 包声明、方法、静态方法、私有字段、常量、构造方法 |
| `fori` `foreach` `ifelse` `switch` | for 循环、for-each、if/else、switch 表达式 |
| `trycatch` `trywith` | try/catch、try-with-resources |
| `stream` `groupby` `opt` `optthrow` | Stream 流水线、分组、Optional 取值、Optional 为空抛错 |
| `async` | CompletableFuture 异步计算 |
| `equals` `tostr` | equals/hashCode、toString |
| `logger` | SLF4J 日志对象 |
| `testclass` `test` `ptest` `assertthrows` | JUnit 5 测试类、测试方法、参数化测试、断言抛错 |
| `restcontroller` | Spring REST 控制器骨架 |

- **任务**：认 `pom.xml`（Maven），列出 `clean`、`compile`、`test`、`package`、`verify`、`install`；`pom.xml` 里有 `spring-boot-maven-plugin` 时多出 `spring-boot:run`，有 `quarkus-maven-plugin` 时多出 `quarkus:dev`。同一文件夹里有 `mvnw` 时用项目自带的 wrapper（Linux / macOS 是 `./mvnw`，Windows 是 `mvnw.cmd`），没有时用系统的 `mvn`。Gradle 项目由软件内置支持，本扩展不重复提供。
- **技能**：`java-project`，Claude Code 里是 `/ext-pixelsky-java:java-project`，Codex 里是 `$java-project`。教 AI 先认 Maven / Gradle 和 wrapper、从构建文件识别 JDK 版本、用项目自己的命令编译和跑 JUnit 测试，不擅自换构建工具或加依赖。
- **提示词**（输入框「/」菜单和编辑器右键里都有，需要先选中代码）：为选中代码写 JUnit 5 测试、解释 Java 异常堆栈、用新语法改写选中代码、补 Javadoc。
- **语法高亮**：软件本来就有内置的 Java 高亮（带代码折叠）。这个扩展自带一份 TextMate 语法，但**默认仍用内置高亮**，装上后外观不会变。想换成扩展的语法，到 设置 › 扩展 › 已安装 › Java 支持 的详情里，打开「用这个扩展代替内置高亮」；注意扩展语法没有代码折叠。关掉开关即可换回。

## 已知问题

- 扩展语法没有代码折叠，所以默认不替换内置高亮。
- 只认 Maven 的 `pom.xml`；任务视图只找根目录往下 3 层，且跳过 `target`、`build` 等目录。
- `spring-boot:run` 和 `quarkus:dev` 靠 `pom.xml` 全文里有没有 `spring-boot-maven-plugin` / `quarkus-maven-plugin` 判断；插件只写在父 POM 里、子模块里没写的情况下不会出现。
- Windows 上是否用 wrapper 只看同一文件夹里有没有 `mvnw`；如果只提交了 `mvnw` 而没有 `mvnw.cmd`，任务会报找不到命令，请改用 `mvn` 手动运行。
- 子模块的任务只在该模块的文件夹里运行，不带上同级模块；它依赖的同级 SNAPSHOT 模块需要先在根目录 `install`。子模块文件夹里没有 `mvnw` 时用系统 `mvn`，不会用根目录的 wrapper。
- 同一文件夹的 `mvnw` 才算 wrapper；wrapper 放在多模块项目根目录、从子模块任务运行时，会用系统的 `mvn`。

## 来源和许可证

本扩展按 MIT 许可发布。语法文件 `syntaxes/java.tmLanguage.json` 来自 microsoft/vscode 的 `extensions/java`（由 redhat-developer/vscode-java 转换，源头是 atom/language-java 和 TextMate 的 Java bundle），许可证为 MIT；具体来源地址和提交号见 `SOURCE.md`，版权声明和许可证全文附在 `LICENSE` 末尾。片段、技能、提示词和示例代码为本扩展自写。
