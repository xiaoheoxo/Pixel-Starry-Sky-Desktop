请把下面这段 {{language}} 代码（文件 {{file}}）改写得更地道，行为保持不变：

```
{{selection}}
```

重点检查：多余的 `clone()` 和 `to_string()`；可以用 `?` 代替的 `match` 或 `unwrap()`；可以用迭代器和 Option / Result 组合子（`map`、`and_then`、`ok_or`、`unwrap_or_default`）简化的循环；参数类型能否改成 `&str` / `&[T]`；`if let` / `let ... else` 能否让分支更平。不要改公开签名，除非我同意。改完运行 `cargo clippy --all-targets` 和 `cargo test`，并列出你改了哪些地方、为什么。
