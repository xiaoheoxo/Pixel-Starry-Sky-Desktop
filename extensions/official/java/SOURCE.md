# 上游来源

| 文件 | 来源 | 提交 | 许可证 |
| --- | --- | --- | --- |
| `syntaxes/java.tmLanguage.json` | https://github.com/microsoft/vscode/blob/05e29316e7f6160069c206a66eeba87799508ce9/extensions/java/syntaxes/java.tmLanguage.json | `05e29316e7f6160069c206a66eeba87799508ce9`（microsoft/vscode，extensions/java 最近一次提交） | MIT |

- 该文件由 VS Code 从 redhat-developer/vscode-java（https://github.com/redhat-developer/vscode-java ，标签 1.26.0，提交 `f09b712f5d6d6339e765f58c8dfab3f78a378183`，`language-support/java/java.tmLanguage.json`）转换而来，来源记录见 microsoft/vscode 同目录的 `cgmanifest.json`。
- 更早的源头是 atom/language-java 的 `grammars/java.cson` 和 TextMate 的 java.tmbundle，许可见 `LICENSE` 末尾的「Third-party notices」。
- 语法文件原样使用，未做修改。

其余文件（`language-configuration.json`、`samples/`、`snippets/`、`skills/`、`prompts/`、`.fixtures/`）均为本扩展自写。
