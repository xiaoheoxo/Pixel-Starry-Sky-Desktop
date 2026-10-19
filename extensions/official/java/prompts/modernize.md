请把下面这段 {{language}} 代码（来自 {{file}}）改写成更现代、更简洁的写法，行为必须保持不变。

要求：
1. 先确认项目使用的 JDK 版本（看 pom.xml 的 maven.compiler.release / java.version，或 Gradle 的 toolchain / sourceCompatibility），只使用该版本支持的语法，不要用更高版本的特性。
2. 可以考虑：var、record、switch 表达式、文本块、instanceof 模式匹配、Stream、Optional、try-with-resources、List.of / Map.of 等，但只在确实更清晰时才用，不要为了新而新。
3. 不改公开方法签名，不新增依赖。
4. 逐条说明改了什么、为什么，改完用项目自己的命令编译并跑相关测试。

代码：

```java
{{selection}}
```
