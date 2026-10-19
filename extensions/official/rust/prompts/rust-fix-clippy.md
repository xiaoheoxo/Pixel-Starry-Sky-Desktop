请在项目 {{project}} 里运行 `cargo clippy --all-targets`（项目 CI 用了别的参数就按 CI 的来），然后逐条处理警告。

优先按 clippy 的 `help:` 建议修改，每条修完保持行为不变；对确实不该改的警告，用带说明的 `#[allow(clippy::xxx)]` 局部放过，不要在 crate 顶部整体关闭。不要顺手升级依赖或工具链，也不要重新格式化无关代码。全部处理完后依次运行 `cargo clippy --all-targets`、`cargo test` 和 `cargo fmt --all --check`，告诉我结果和每类警告的处理方式。
