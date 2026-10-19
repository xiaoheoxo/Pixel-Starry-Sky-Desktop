---
name: java-project
description: 在 Java 项目里写代码、跑测试、修编译和依赖报错时使用，包括判断用 Maven 还是 Gradle、识别 JDK 版本、运行 JUnit。Use when working in a Java project: choosing between Maven and Gradle, detecting the JDK version, building, running JUnit tests, fixing compile or dependency errors.
---

# Java 项目工作指南

## 先认工具链，不要擅自换

1. 看根目录（和子模块）里有什么：
   - `pom.xml` 是 Maven；`build.gradle` / `build.gradle.kts` / `settings.gradle(.kts)` 是 Gradle。两种同时存在时，以 README 和 CI 配置（`.github/workflows`、`Jenkinsfile`）里实际用的为准。
   - 优先用项目自带的 wrapper：`./mvnw`（Windows 下 `mvnw.cmd`）、`./gradlew`（Windows 下 `gradlew.bat`）。wrapper 锁定了构建工具版本，只有没有 wrapper 时才用系统的 `mvn` / `gradle`。
2. 沿用项目已有的构建工具、测试框架和依赖管理方式。**不要**把 Maven 项目改成 Gradle，**不要**为了方便新增依赖、插件或升级版本；确实需要新依赖时，先说明理由，让用户确认。
3. 多模块项目先看根 `pom.xml` 的 `<modules>` 或 `settings.gradle` 的 `include`，在要改的模块里工作。

## 识别 JDK 版本

- Maven：`pom.xml` 里的 `maven.compiler.release`、`maven.compiler.source` / `target`、`java.version`（Spring Boot 父 POM 常用），或 `maven-compiler-plugin` 的 `<release>`。
- Gradle：`java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }`，或 `sourceCompatibility`。
- 其他线索：`.java-version`、`.sdkmanrc`、`.tool-versions`（asdf / mise）、CI 里的 `setup-java`、`Dockerfile` 的基础镜像。
- 本机实际版本用 `java -version` 和 `javac -version`；`./mvnw -v` 会同时显示 Maven 用的是哪个 JDK。
- 只使用该版本支持的语法：`var` 需要 10+，switch 表达式 14+，文本块 15+，`record` 和 instanceof 模式匹配 16+，密封类 17+，switch 的模式匹配 21+。

## 构建和验证（改完代码按这个顺序）

Maven：

```
./mvnw -q compile                                # 先确认能编译
./mvnw test                                      # 运行单元测试
./mvnw test -Dtest=OrderServiceTest              # 只跑一个测试类
./mvnw test -Dtest=OrderServiceTest#shouldPay    # 只跑一个方法
./mvnw verify                                    # 提交前：测试 + 集成测试 + 打包检查
```

Gradle：

```
./gradlew compileJava
./gradlew test
./gradlew test --tests "com.example.OrderServiceTest"
./gradlew check                   # 测试 + 项目配置的静态检查
```

- 多模块下只构建一个模块：Maven `./mvnw -pl 模块名 -am test`，Gradle `./gradlew :模块名:test`。`-am` 与 `-Dtest` 一起用时要加 `-Dsurefire.failIfNoSpecifiedTests=false`（Surefire 2.22 之前用 `-DfailIfNoTests=false`），否则上游模块里没有匹配的测试会报错：`./mvnw -pl 模块名 -am test -Dtest=OrderServiceTest -Dsurefire.failIfNoSpecifiedTests=false`。
- 网络不通时可加 Maven 的 `-o`（离线）；依赖确实缺失时，如实告诉用户，不要改仓库地址。
- 项目配置了格式化或静态检查（`spotless`、`checkstyle`、`spotbugs`）时，改完跑对应目标，例如 `./mvnw spotless:apply`、`./gradlew spotlessApply`；没配置就不要自己引入。

## 测试（JUnit）

- 先看现有测试用的是 JUnit 5（`org.junit.jupiter`）还是 JUnit 4（`org.junit.Test`），以及有没有 Mockito、AssertJ、Testcontainers；照现有风格写，不要混用 4 和 5 的注解。
- 测试放 `src/test/java`，包名与被测类一致，类名以 `Test` 结尾或开头（Maven Surefire 默认认 `*Test`、`Test*`、`*Tests`、`*TestCase`；集成测试 `*IT` 由 Failsafe 在 `verify` 阶段跑）。
- JUnit 5 常用：`@Test`、`@ParameterizedTest` + `@CsvSource` / `@MethodSource`、`@BeforeEach`、`@Nested`、`assertThrows`、`assertAll`。参数化测试需要 `junit-jupiter-params`（用聚合包 `junit-jupiter` 时已包含），项目没有时不要偷偷加，先问。
- 先看测试失败的真实原因（Surefire 报告在 `target/surefire-reports`，Gradle 在 `build/reports/tests`），不要为了变绿去改断言或删测试。

## 常见坑

- `UnsupportedClassVersionError` / `invalid target release`：运行或编译用的 JDK 低于项目要求，先对照上面的版本线索，不要降低项目的 `release`。
- `NoSuchMethodError`、`ClassNotFoundException`：多半是依赖版本冲突，用 `./mvnw dependency:tree` 或 `./gradlew dependencies` 查，通过项目现有的版本管理（`dependencyManagement` / BOM / version catalog）解决。
- 注解处理器（Lombok、MapStruct）靠构建文件里的配置工作，改了注解后先完整编译再判断结果。
- `target/` 和 `build/` 是产物，不提交、不手改；`./mvnw clean` 只在怀疑缓存脏时用。
- Windows 的 PowerShell 里 Maven 带 `#` 或 `.` 的参数建议加引号，如 `./mvnw test "-Dtest=OrderServiceTest#shouldPay"`。
