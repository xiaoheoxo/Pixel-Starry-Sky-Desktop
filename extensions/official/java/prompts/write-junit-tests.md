请为下面这段 Java 代码（文件 {{file}}，项目 {{project}}）写单元测试。

要求：
1. 先看项目里已有的测试：用的是 JUnit 5 还是 JUnit 4 / TestNG，有没有 Mockito、AssertJ，沿用它们的写法和目录结构（src/test/java 下与被测类同包），不要擅自引入新的测试依赖。
2. 覆盖正常路径、边界值（null、空集合、0、负数）和会抛出异常的路径。
3. 测试方法名要说清场景和预期，每个测试只验证一件事；多组输入用参数化测试（项目已有 junit-jupiter-params 时）。
4. 写完后用项目自己的方式运行（有 mvnw 用 ./mvnw test，有 gradlew 用 ./gradlew test），失败时先弄清原因再修，不要为了通过而改被测代码。

被测代码：

```java
{{selection}}
```
