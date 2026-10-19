---
name: kotlin-project
description: 在 Kotlin 项目（JVM、Android、Kotlin Multiplatform）里写代码、跑测试、修编译报错时使用。Use when working in a Kotlin project, including writing code, running tests and fixing Gradle or compiler errors.
---

# Kotlin 项目工作约定

## 先认清项目，再动手

1. 看根目录：`settings.gradle.kts` / `settings.gradle`、`build.gradle.kts` / `build.gradle`、`gradlew`（`gradlew.bat`）、`gradle/libs.versions.toml`、`gradle/wrapper/gradle-wrapper.properties`、`pom.xml`。
2. **用项目自己的工具**：有 Gradle wrapper 就一律用 `./gradlew`（Windows PowerShell 用 `.\gradlew.bat`），不要改用系统里的 `gradle`；只有 `pom.xml` 的 Kotlin 项目用 `mvn`（有 `mvnw` 优先用 `./mvnw`）。不擅自换构建工具、不升级 Kotlin / Gradle / JDK 版本、不添加新依赖；确实需要时先说明理由并等确认。
3. 依赖若由版本目录管理（`libs.versions.toml`），改依赖就改那里，别在子项目里写死版本。
4. 先读 `.editorconfig`、已有代码风格和测试写法，照着写。

## 判断项目类型

- **Kotlin/JVM**：插件 `kotlin("jvm")`（`org.jetbrains.kotlin.jvm`），源码在 `src/main/kotlin`，测试在 `src/test/kotlin`。
- **Android**：插件 `com.android.application` / `com.android.library`，有 `AndroidManifest.xml`；需要 Android SDK（`local.properties` 的 `sdk.dir` 或 `ANDROID_HOME`）。单元测试 `./gradlew testDebugUnitTest`，设备测试 `connectedDebugAndroidTest` 需要模拟器或真机，没有就不要硬跑。
- **Kotlin Multiplatform**：插件 `kotlin("multiplatform")`，源码集 `commonMain` / `commonTest` / `jvmMain` / `iosMain` 等。公共代码只能用多平台可用的 API；平台相关测试任务要在对应系统上才能跑（iOS 需要 macOS）。
- **Kotlin 脚本**：`*.gradle.kts` 是构建脚本；独立 `*.kts` 脚本由项目约定的方式运行，不要凭空假设。

## 验证改动（由快到慢）

1. 编译：`./gradlew compileKotlin`（Android 用 `compileDebugKotlin`，多平台用 `compileKotlinJvm` 等对应目标）。
2. 受影响的测试：`./gradlew :模块名:test --tests "com.example.FooTest"`（单个类）或 `--tests "com.example.FooTest.方法名"`；`--tests` 必须配合具体模块的测试任务，不要在多模块根项目上直接跑 `test --tests`（其他模块会报 No tests found）。Android 用 `:app:testDebugUnitTest --tests ...`（生命周期任务 `test` 不接受 `--tests`），多平台用 `:模块名:jvmTest --tests ...`（`allTests` 同样不接受）。
3. 全量：`./gradlew build`（含 `check`：测试和已配置的 lint）。
4. 格式与静态检查——**只在项目已配置时才跑**，先看构建文件里有没有对应插件：
   - ktlint：`./gradlew ktlintCheck`，自动修复 `./gradlew ktlintFormat`（Spotless 项目是 `spotlessCheck` / `spotlessApply`，Kotlinter 项目是 `lintKotlin` / `formatKotlin`；不确定时先跑 `./gradlew tasks --group verification` 看真实任务名）。
   - detekt：`./gradlew detekt`；有 baseline 文件（`detekt-baseline.xml`）时不要为了过检查而随意重生成基线。
5. 速度慢时可加 `--offline`（依赖已缓存）、`-q`；排查失败加 `--stacktrace`，需要看完整测试输出加 `-i`。已有 Gradle 守护进程时别随意 `--no-daemon`。

## 写代码的要点

- 优先 `val`、不可变集合、`data class`；用 `?.` `?:` `let` 处理空值，避免 `!!`；对密封类用不带 `else` 的穷尽 `when`，新增子类时编译器会提醒漏处理的分支。
- 协程：不用 `GlobalScope`；挂起函数不阻塞线程（阻塞 IO 放 `Dispatchers.IO`）；不要吞掉 `CancellationException`；测试用 `kotlinx-coroutines-test` 的 `runTest`，不要 `Thread.sleep`。
- 公开 API 要写明显式返回类型；改公开签名前先查调用方（含其他模块）。
- 注解处理：kapt / KSP 生成的代码在 `build/` 下，不要手改；改了注解后重新构建让它重新生成。

## 常见坑

- Kotlin、Gradle、JDK、Android Gradle Plugin 版本要互相兼容；编译报 "Unsupported class file major version" 或插件解析失败多半是 JDK / Gradle 版本不匹配，先查 `gradle-wrapper.properties`、`jvmToolchain` 和 `JAVA_HOME`，不要靠降级项目配置绕开。
- 增量编译或缓存异常时先 `./gradlew clean` 再重试一次，仍失败再查真正原因；不要把 `clean` 当作常规步骤。
- 报错很长时只看第一个 `e:` 开头的编译错误和 "What went wrong" 段落，后面多是连带错误。
- 不要提交 `build/`、`.gradle/`、`local.properties`、`*.iml`；不要修改 `gradle-wrapper.jar`（除非是明确的 wrapper 升级）。
- 改完后在最终说明里写清：跑了哪些命令、结果如何、哪些没法在本机验证（如设备测试、iOS 目标）。
