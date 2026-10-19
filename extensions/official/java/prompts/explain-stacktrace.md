下面是 {{project}} 项目里的一段 Java 异常堆栈或报错，请帮我定位原因。

要求：
1. 先指出真正的根因：从最底部的 "Caused by" 往上看，区分框架内部的栈帧和项目自己的代码（以项目包名开头的栈帧）。
2. 对应到项目里具体的文件和行号，打开相关代码确认，不要只凭报错文字猜测。
3. 说明触发条件（什么输入或什么状态会出现），再给最小的修复方案。
4. 如果可能与 JDK 版本或依赖版本冲突有关（NoSuchMethodError、ClassNotFoundException、UnsupportedClassVersionError），先查项目的 pom.xml 或 build.gradle 里的版本再下结论；不要擅自升级依赖或更换构建工具。

报错内容：

```
{{selection}}
```
