---
name: rust-project
description: 在 Rust 项目里写代码、跑测试、修编译报错和借用检查器错误时使用。Use when working in a Rust project (cargo build/check/test/clippy/fmt, workspaces, features, rust-toolchain, borrow checker errors).
---

# Rust 项目工作流

## 先认清项目

动手前先看，不要凭印象：

- 根目录的 `Cargo.toml`：是单个包（有 `[package]`）、虚拟工作区（只有 `[workspace]`）还是两者都有；`members`、`default-members`、`[workspace.dependencies]`、`[features]`。
- `Cargo.lock`：二进制项目通常提交；库项目可能没有。**不要为了"整洁"删掉或重新生成锁文件**，也不要随手 `cargo update`。
- `rust-toolchain.toml`（或旧的 `rust-toolchain`）：固定了工具链和组件，`rustup show` 能看到实际生效的版本。`Cargo.toml` 的 `rust-version` 是最低支持版本（MSRV）。
- `rustfmt.toml` / `.rustfmt.toml`、`clippy.toml`、`.cargo/config.toml`、CI 配置（`.github/workflows`）：CI 里怎么跑，本地就怎么跑。
- 用项目已有的工具和依赖。**不要擅自换工具、升级工具链、加新依赖或改 edition**；确实需要时先说明理由再改。

## 验证改动的顺序

从快到慢，每一步通过再走下一步：

1. `cargo check`：只做类型和借用检查，最快。
2. `cargo clippy --all-targets -- -D warnings`：lint；项目 CI 没有加 `-D warnings` 时，至少保证不新增警告。
3. `cargo test`：单元测试、集成测试（`tests/`）和文档测试一起跑。
4. `cargo fmt --all --check`：格式。要自动修用 `cargo fmt --all`。

只改了某个包时加 `-p <包名>`（`cargo test -p mycrate`）。只跑某个测试：`cargo test <名字片段>`；看测试里的输出：`cargo test -- --nocapture`；单线程：`cargo test -- --test-threads=1`。

## 工作区和 feature

- 有根包的工作区默认只处理根包（或 `default-members`），虚拟工作区默认处理全部成员；要明确覆盖全部成员用 `--workspace`。
- 有 feature 的项目，改动可能只在某组 feature 下才编译：先 `cargo check --all-features`，再确认默认组合 `cargo check` 和 `cargo check --no-default-features` 也能过（项目支持的话）。
- 指定 feature：`--features a,b`；工作区里指定某个包的 feature：`--features pkg/feat`。
- 条件编译代码（`#[cfg(feature = "x")]`、`#[cfg(target_os = "windows")]`）在当前组合下不会被检查，改它们时要换组合再检查一次。
- 依赖放在 `[workspace.dependencies]` 的，成员里用 `dep = { workspace = true }`，不要在成员里另写版本。

## 最低支持版本（MSRV）

- 有 `rust-version` 或 `rust-toolchain.toml` 时，不要使用更新版本才稳定的 API 和语法。
- 不确定时用 `rustup run <版本> cargo check` 验证（该版本必须已安装；不要自动装，先问用户）。

## 处理编译器报错

1. **从第一个错误开始**，后面的常常是它引起的；`cargo check` 比 `cargo build` 反馈更快。
2. 完整读一遍报错：标出的行、`help:` 建议、`note:` 里说明的借用来源。需要更详细的解释：`rustc --explain E0502`（错误码以实际输出为准）。
3. 常见借用检查器错误的思路：
   - E0382 使用了已移动的值：先想能不能传引用 `&T`；真需要所有权再 `clone()`，并说明为什么克隆是合理的。
   - E0499 / E0502 同时存在可变借用和其他借用：缩小借用的作用域，把读取的结果先存进局部变量，或把一次操作拆成"先算后改"两步；不要用 `unsafe` 绕过。
   - E0505 / E0597 借用比值活得久：检查返回的引用来自哪个局部变量，改成返回拥有所有权的值，或让调用方提供存储。
   - E0106 缺生命周期标注：先看是否可以返回拥有所有权的类型；确需引用时，让生命周期参数把输出和对应的输入关联起来。
   - E0277 trait 约束不满足：看 `help:` 提示缺哪个 trait；`Send` / `Sync` 错误通常来自 `Rc`、`RefCell` 或跨 `.await` 持有的非 `Send` 值。
4. **不要用来"消灭报错"的做法**：到处 `clone()`、`Rc<RefCell<..>>`、`unsafe`、`#[allow(...)]`、把 `unwrap()` 当错误处理。确实要用时在旁边写清原因。
5. 改完重新跑上面的验证顺序，而不是只看那一个错误消失。

## 写代码的习惯

- 库代码用 `Result` 返回错误，不用 `unwrap()` / `expect()` / `panic!`（测试和确实不可能失败且已注明原因的地方除外）；错误类型沿用项目已有的方案（`thiserror`、`anyhow` 或自定义枚举），没有就用标准库。
- 函数参数优先接受 `&str`、`&[T]`、`&Path`，而不是 `&String`、`&Vec<T>`、`&PathBuf`。
- 公开 API 加文档注释 `///`，示例会被 `cargo test` 当文档测试跑。
- 新增的 `unsafe` 要附 `// SAFETY:` 注释，说明为什么满足前提。
- 不要修改与任务无关的代码格式；格式交给 `cargo fmt`。
