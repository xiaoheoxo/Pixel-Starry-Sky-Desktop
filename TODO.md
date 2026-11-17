# 待验证事项

## ChatGPT Dot

- [x] 使用真实 Pro 10x 账号验证 Dot 目录、profile/room 身份、32 条历史、附件元数据、环境和活动/任务列表读取。
- [x] 在测试安装版验证历史消息及四张图片预览，使用真实账号取得 Dot 电脑的 WebRTC 信令应答。
- [ ] 在 dot.6 测试安装版验收右侧对话标签、原生文件发送与回复、Dot 电脑画面及控制、真实工作流卡片更新。安装完成，交互验收尚未完成。
- [ ] 在多账号环境验证切换、令牌失效和重新登录后的提示；本机只读联调仅有一个开通 Dot 的真实账号。
- [ ] 在可用的 Flutter SDK 环境运行 `flutter test` 核对已更新的引擎能力常量；本机未找到 Flutter / Dart。
- [ ] 完成桌面端全量回归：本次全量测试出现 node-pty `AttachConsole failed`，WSL 测试尝试下载 Electron，402 秒后仍未结束，已主动清理测试进程；相关通道、工作流状态和平台路由测试已通过。
- [ ] 排查存量 `packages/engine/test/prepare.test.ts` 的 `Store.loadItemsAsync` 超时：首次实现前即复现，最终引擎回归其余 1719 项通过、1 项跳过。
