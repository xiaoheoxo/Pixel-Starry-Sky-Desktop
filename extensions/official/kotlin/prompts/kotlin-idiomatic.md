请把 {{file}} 里下面这段 {{language}} 代码改写得更地道，但保持行为完全不变：

```
{{selection}}
```

可以考虑：用 val 代替 var、用 ?. / ?: / let 替代手写的 null 判断、避免滥用 !!、用 when 和密封类代替 if-else 链、用集合 API（map / filter / associate / groupBy）和序列替代手写循环、在私有或 internal 代码里用默认参数和命名参数代替重载、用 data class 或 value class 表达数据。不要为了炫技而降低可读性，不要改公开 API 的签名，也不要引入新依赖。改完后说明每处改动的理由，并运行项目已有的测试和 lint（如已配置 ktlint / detekt）确认没有回归。
