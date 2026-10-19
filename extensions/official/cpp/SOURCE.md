# 上游文件来源

| 文件 | 来源 | 提交号 | 许可证 |
| --- | --- | --- | --- |
| `syntaxes/c.tmLanguage.json` | https://github.com/microsoft/vscode/blob/9a59550fc841805ebb44cfd5a09b92beed591d15/extensions/cpp/syntaxes/c.tmLanguage.json | vscode `9a59550fc841805ebb44cfd5a09b92beed591d15`（2026-10-17 的 main）；其上游 jeff-hykin/better-c-syntax `34712a6106a4ffb0a04d2fa836fd28ff6c5849a4` | MIT |
| `syntaxes/cpp.tmLanguage.json` | https://github.com/microsoft/vscode/blob/9a59550fc841805ebb44cfd5a09b92beed591d15/extensions/cpp/syntaxes/cpp.tmLanguage.json | vscode `9a59550fc841805ebb44cfd5a09b92beed591d15`；其上游 jeff-hykin/better-cpp-syntax `071dd6ecc9eda347bd84c8aa0e0b557396cb6a40` | MIT |

两个文件原样复制，未改动。提交号和许可证依据 vscode 仓库 `extensions/cpp/cgmanifest.json`（better-cpp-syntax 1.27.1、better-c-syntax 1.13.2，MIT，Copyright (c) 2019 Jeff Hykin）。

上游说明：这些语法最初派生自 atom/language-c，后者转换自 TextMate 的 C bundle（textmate/c.tmbundle）。
`language-configuration.json` 是本扩展自己写的，不是上游文件。

## 其他组件（来自 vscode 的 cgmanifest.json）

| 组件 | 来源 | 提交号 | 许可证 |
| --- | --- | --- | --- |
| textmate/c.tmbundle | https://github.com/textmate/c.tmbundle | `60daf83b9d45329524f7847a75e9298b3aae5805` | TextMate Bundle License（宽松许可：允许复制、使用、修改、出售和分发，按「现状」提供；全文见 `LICENSE`） |

vscode 本身是 MIT（Copyright (c) 2015 - present Microsoft Corporation），全文也在 `LICENSE`。

**待确认的决定**：TextMate Bundle License 不在 AUTHORING 3.5 列的 MIT / Apache-2.0 / BSD 里。它只是该语法的间接上游组件，条款宽松、没有版权声明的传播限制，这里已完整附上；是否接受需要项目负责人明确确认，确认后请记入 AUTHORING。
