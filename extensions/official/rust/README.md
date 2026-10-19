# Rust 支持

Rust 的代码片段、clippy / fmt / doc 任务、cargo 工作流技能和常用提示词。

## 装上以后

- **代码片段**：在 `.rs` 文件里输入前缀展开。

| 前缀 | 作用 |
| --- | --- |
| `main` / `mainres` | `fn main`；返回 `Result` 的 `main` |
| `fn` / `pfn` / `afn` | 函数 / `pub fn` / `async fn` |
| `fnres` | 返回 `Result` 并用 `?` 传播错误的函数 |
| `struct` / `structimpl` / `impl` | 结构体 / 结构体加 `new` / `impl` 块 |
| `enum` / `derive` | 枚举 / `#[derive(...)]` |
| `trait` / `impltrait` | trait 定义 / 为类型实现 trait |
| `match` / `matchopt` / `matchres` | `match`；匹配 `Option`；匹配 `Result` |
| `iflet` / `letelse` / `whilelet` / `for` | 各种分支和循环 |
| `errtype` | 只用标准库的错误枚举（`Display`、`Error`、`From`） |
| `impldefault` / `impldisplay` | 实现 `Default` / `Display` |
| `readfile` | 读取整个文本文件 |
| `testmod` / `test` / `testpanic` / `testres` | 测试模块 / `#[test]` / `#[should_panic]` / 返回 `Result` 的测试 |
| `iterchain` / `optchain` | 迭代器链 / `Option` 组合子链 |
| `hashmap` | `HashMap` 加 `entry` 计数 |
| `arcmutex` / `spawn` | `Arc<Mutex<_>>` / `std::thread::spawn` 加 `join` |
| `tokiomain` / `tokiotest` | `#[tokio::main]` / `#[tokio::test]`，**需要项目已依赖 tokio** |
| `doc` | 带示例的文档注释 |

- **任务**：软件自己认 `Cargo.toml`（`build` `check` `test` `run`）。本扩展补充的任务**挂在 `Cargo.lock` 上**，避免和内置的重复：
  - `clippy`：`cargo clippy`；`doc`：`cargo doc --no-deps`（不为依赖生成文档）
  - `clippy-strict`：`cargo clippy --all-targets -- -D warnings`（不带 `--all-features`，因为互斥的 feature 会让它报错；需要时在终端里自己加）
  - `fmt`：`cargo fmt --all`；`fmt-check`：`cargo fmt --all --check`
  - 认 `rust-toolchain.toml` / `rust-toolchain`：`toolchain`（`rustup show`，显示项目实际使用的工具链）
- **技能**：`rust-project`，Claude Code 里是 `/ext-pixelsky-rust:rust-project`，Codex 里是 `$rust-project`。讲 cargo 验证顺序（check、clippy、test、fmt）、工作区与 feature、MSRV 与工具链文件，以及借用检查器报错的处理思路，并要求沿用项目已有的工具和锁文件。
- **提示词**：输入框「/」菜单和编辑器右键里有：为选中代码写 Rust 测试、解释借用检查器报错、改写成地道的 Rust（这三条需要先选中代码）；另有「清掉 clippy 警告」，只在输入框「/」菜单里。

## 已知问题

- 补充的任务只在文件夹里有 `Cargo.lock` 时出现。没有提交锁文件的库项目看不到 `clippy`、`doc`、`fmt` 等任务，可以直接在终端里运行对应的 cargo 命令。
- 子目录里的 `Cargo.lock` 会各自成一组，命令在该目录下执行；工作区成员一般没有自己的锁文件，所以只会出现根目录那一组。
- `toolchain`（`rustup show`）通常只读，但较老的 rustup（1.28 之前）在项目固定的工具链没装时会顺带下载安装，可能下载很大。
- `fmt` 会直接改文件；只想检查用 `fmt-check`。
- 不带语法高亮：`.rs` 的高亮由软件内置提供。

## 来源和许可证

片段、技能、提示词均为原创，以 MIT 许可证发布，见 `LICENSE`。
