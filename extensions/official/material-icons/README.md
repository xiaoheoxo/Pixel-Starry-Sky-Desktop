# Material Icon Theme

像素星空官方的文件图标主题（文件树、标签上的彩色图标）。

- 来源：https://github.com/material-extensions/vscode-material-icon-theme
- 版本：5.39.0
- 许可证：MIT（见 LICENSE）
- 改动：只改了文件位置——`dist/material-icons.json` 放到 `theme/material-icons.json`，`icons/` 原样拷贝，内容一个字节没改。

重新生成：`node extensions/official/scripts/vendor-material-icons.mjs <material-icon-theme 的 package 目录>`（在仓库根目录）。
