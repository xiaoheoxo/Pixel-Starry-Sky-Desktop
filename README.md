# Pixel-Starry-Sky-Desktop

**像素星空**：一个桌面端 AI 编程工作台。在一个窗口里管理本机和云端机器、项目、会话，让 Claude Code、Codex 或像素星空自带的引擎（Pixel）帮你写代码。

## 下载

到 [Releases](https://github.com/xiaoheoxo/Pixel-Starry-Sky-Desktop/releases) 下载。正式版有 Windows（安装版 exe）、macOS（dmg，Intel 和 Apple 芯片）、Linux（AppImage 和 deb）；带 `-beta` 的测试版目前只有 Windows。

还没有代码签名：

- Windows 第一次运行会提示「未知发布者」，点「更多信息 → 仍要运行」。
- macOS 第一次打开会被系统拦住，到「系统设置 › 隐私与安全性」里点「仍要打开」。macOS 上不能自动更新，有新版时会提示去下载。

## 批量导入项目

在「设置 → 项目」中（也可以从项目列表的「＋ → 从其他工具导入…」进入），打开时会自动读取 Claude Code、Codex、Z Code、Kimi Code、Cursor 和 DeepSeek Harness 保存的本机项目，每个工具显示找到几个、几个可以添加；也可以手动选择项目文件夹、扫描父文件夹或粘贴路径。列表按「可添加 / 已添加 / 失效」分开显示，支持搜索、勾选和去重，添加时可以放进已有分区或新建分区；添加完留在页面上，可以继续导入下一批。

自动发现支持 Claude 的 `.claude.json`、Codex 的 `.codex-global-state.json`、Z Code 的 `setting.json` 和只读任务索引、新版 Kimi Code 的 `workspaces.json`、旧版 Kimi CLI 的 `kimi.json`，以及 Cursor 的 `workspaceStorage` 文件夹和 DeepSeek Harness 的 `storages` 文件夹。支持相应工具的目录环境变量；使用自定义位置时，也可以手动选择清单，或粘贴路径、读取每行一个绝对路径的 TXT / JSON 字符串数组。最多预览 10000 个路径，分批添加，失败项保留以便重试。

导入只登记已有项目文件夹，不搬动文件，也不迁移会话或工具设置。Z Code 的远程工作区、无项目会话和 Kimi 已删除的工作区不会导入。

## 反馈

遇到问题或想要新功能，到 [Issues](https://github.com/xiaoheoxo/Pixel-Starry-Sky-Desktop/issues/new/choose) 提交，选一个模板：

- **问题反馈（Bug）**：软件出错、显示不对、和预期不一致。
- **功能请求**：想要新功能，或改进现有功能。

提交之前：

1. 先更新到[最新版本](https://github.com/xiaoheoxo/Pixel-Starry-Sky-Desktop/releases)，看问题是否已经修好。
2. 搜一下[已有的 issue](https://github.com/xiaoheoxo/Pixel-Starry-Sky-Desktop/issues?q=is%3Aissue)，有人提过就在那里补充。
3. 一个 issue 只写一个问题或一个功能。

问题反馈请带上：

- 版本号和系统：版本号在「设置 › 关于」里能看到；系统写清楚版本，例如 Windows 11 24H2。
- 复现步骤、实际结果和期望结果。显示类的问题附上截图或录屏。
- 日志：在「设置 › 日志」点「复制最近的错误」，粘贴到「日志」一栏；需要更多信息时点「导出诊断文件」，把导出的文件拖到「截图或录屏」一栏。日志写入前已去掉密钥和令牌。

也可以在应用里的「设置 › 反馈」提交：登录像素星空账号后，团队的回复会显示在那里。

安全问题请不要公开提 issue，到[这里私下报告](https://github.com/xiaoheoxo/Pixel-Starry-Sky-Desktop/security/advisories/new)。

## 从源码运行

需要：Node 22+、pnpm 11（版本以根目录 `package.json` 的 `packageManager` 为准）。

```bash
pnpm install       # 安装依赖（会下载 Electron）
pnpm dev           # 开发模式
pnpm dev:demo      # 开发模式（演示数据）
pnpm check         # 类型检查、测试、ESLint、Prettier
pnpm dist          # 打包 Windows 安装包到 apps/desktop/release/
```

macOS、Linux 的安装包要在对应系统上打：`pnpm --filter @pixelsky/desktop dist:mac`、`pnpm --filter @pixelsky/desktop dist:linux`。

**Electron 下载失败（`fetch failed`）**：电脑走代理时，Node 默认不使用系统代理。设置 `NODE_USE_ENV_PROXY=1` 后重装：

```bash
NODE_USE_ENV_PROXY=1 node node_modules/.pnpm/electron@*/node_modules/electron/install.js
```
