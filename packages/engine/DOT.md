# ChatGPT Dot

Dot 接入现有引擎库，复用聊天、消息队列和智能体追踪面板。输入框的模型菜单中选择 **ChatGPT Dot**，发送自然语言任务；Dot 自己决定是否派出 Work / Codex 任务，任务卡片映射为 `WorkflowRun`，在聊天这一轮结束后继续刷新状态。

## 配置

先在 ChatGPT 中创建并启用自己的 Dot。「设置 → 模型通道」在 ChatGPT 授权卡片下方提供独立的 **ChatGPT Dot** 卡片。

Dot 与 Codex 共用同一套 ChatGPT 登录、已保存账号和当前账号选择。直接使用卡片上的登录、切换账号和管理账号按钮；登录流程仍由现有 Codex 浏览器授权或设备码授权完成。切换、重新登录或退出在两处同时生效。无需手填 token，不新增 Dot 凭据文件，也不把凭据写入引擎环境变量或设置同步。

仅为 Pro 20x（`pro`）、Pro 10x（`prolite`）和 Pro 50x（`promax`）显示 Dot；Plus 等其它档位不显示入口，也不查询其 Dot 列表。侧栏「频道」下面是 Dot 总入口，普通对话列表下面是动态入口。总入口汇总所有已保存 Pro 账号的 Dot，动态入口显示 Dot 名称及所属账号。

每个“账号 + Dot”打开主窗口右侧的对话标签，再次点击切回已有标签。总入口打开首个可用 Dot，动态入口可选择其它账号和 Dot，不切换 Codex 的全局当前账号。会话固定账号及远端 Dot 身份，本地聊天记录和草稿分别保存。目录元数据、会话引用保存于数据目录的 `dot-chats.json`，不含凭据。刷新目录可发现新增 Dot 和账号套餐变化。

聊天沿用像素星空正常对话的主题、居中阅读列、右侧用户气泡、Markdown 和输入卡片。输入卡片通过 `ComposerArea` 共用宽度偏好；详情面板可收起，显示真实头像、上次活跃、设备、近期活动和输出文件。历史记录每页 32 条，可向前加载；可见标签每 10 秒按最新游标增量同步，回到窗口立即补抓，向前翻页不改最新游标。环境概况独立刷新，不阻塞消息；可选活动列表未开放时补查近期对话中的已验证任务卡片和输出附件，并提供 ChatGPT 入口；定时任务单独读取 Dot 范围的 automations 列表，不从会话任务推断；此读取依赖网页接口，不保证账号均获支持，也不读取全账号资料库。图片按文件 ID 从同一房间刷新签名 URL，由主进程下载后在客户端内预览；文件使用原生保存对话框。

添加照片或文件使用原生文件选择器，最多 10 个、每个 20 MiB；主进程校验并上传，再将文件 ID 随消息发送。上传失败不会只发送文字。Dot 电脑在当前对话区内切换到 WebRTC 视图，OAuth 认证和 SDP 交换留在主进程；默认观察，用户主动申请控制，离开视图或窗口时归还控制权。以上入口不跳转网页。

凭据由 Codex app-server 的 `getAuthStatus(includeToken: true)` 在主进程内读取，使用当前或固定已保存账号对应的 `CODEX_HOME`，兼容 Codex 自己的文件或系统凭据库存储。默认账号未物化到账号清单时也能复用现有登录。即将过期时让 Codex 刷新并保存。API Key 和不含 ChatGPT 身份的凭据不能用于 Dot。每次请求仍核对账号身份；更换目录中的登录不能继续使用旧房间。

发送前读取指定 Dot 或 primary Dot、profile 和 room，核对 Dot ID、房间 ID、房间类型以及人类和 Dot 成员。人类成员兼容令牌里的 `chatgpt_user_id` 与 `chatgpt_account_user_id`，后续发送校验使用实际验证过的房间成员 ID。按线程查询返回 404 时，仅按同一个 Dot ID 获取当前线程并重新核验房间；不会改选另一个 Dot 或账号。认证请求禁用缓存及 Chromium Cookie，身份来自已保存的 Codex 账号。多个本机会话共用同一个真实 Dot 及其记忆；同一房间只允许一个本机会话同时等待对话回复，不同账号或 Dot 可以并行。

## 可复用接口

`@pixelsky/engine` 导出 `DotAdapter`、`DotClient` 及其配置、身份、消息和任务类型。客户端是纯 Node 实现，可注入 `fetch` 和凭据读取函数，不依赖 Electron。

```ts
import { DotClient } from '@pixelsky/engine'

const client = new DotClient({
  credentials: () => ({ accessToken, accountId, accountUserId }),
})
const dot = await client.discover(signal)
const sent = await client.send(dot, '调查项目问题并交给 Codex 修复', requestId, signal)
const messages = await client.messages(dot, sent.id, signal)
// 对 Dot 消息中的 { type: 'thread', thread_id } 附件查询 client.workflow(dot, message, threadId, signal)。
```

消息 `request_id` 和 `idempotency_token` 复用宿主的用户条目 ID。POST 不自动重试，未确认送达时将队列项标为 `uncertain`；先到 ChatGPT 核对，再决定是否手动重发。读取消息完整遍历分页并检查游标循环，回复到达后核对 root thread 空闲才结束这一轮。确认送达满一分钟还没有回复时，只显示「暂未回复」，不停止、不自动重发，也不提前交付队列；迟到的回复照常显示。读取请求有超时，关闭连接会取消本地请求和轮询。

## 协议依据

这使用的是公开源码中记录的 **ChatGPT 网页协议**，不是 OpenAI 承诺稳定的 Dot 模型 API：

- [Beeper ChatGPT Dots 原生客户端](https://github.com/beeper/chatgpt-dots/blob/main/pkg/chatgpt/client.go)：Dot 发现、房间身份、消息分页及幂等发送字段。
- [Beeper 任务查询](https://github.com/beeper/chatgpt-dots/blob/main/pkg/chatgpt/thread.go)：线程附件及任务状态。
- [ChatGPT 官方 Dot 说明](https://learn.chatgpt.com/docs/dots)：Dot 对话与派出的工作任务。
- [OpenAI Codex 账号接口](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/account_processor.rs)：`getAuthStatus` 的令牌读取及刷新。
- [Dots CLI 账号目录接口](https://github.com/quivent/Dots/blob/main/cli/api.py)：`GET /tbo?limit=25&include_room_preview=false`，`items` 与 `cursor` 分页。

消息调用 `chatgpt.com/backend-api/tbo/*` 和 `messaging/rooms/*`；任务查询调用 `codex-cloud-backend.chatgpt.com/v1/threads/*` 及 `/v2/threads/*/turns`。代码按这些公开协议字段独立编写，没有引入或复制第三方桥接代码，也不依赖兼容 API 代理。

## 当前边界

- 支持文本对话、续接当前 Dot、分页读取、派出的任务标题及运行/等待输入/完成/失败/中断状态。等待输入时提示到 ChatGPT 处理；任务状态读取失败不把已收到的聊天回复判成失败。
- 不报告未提供的 token 或费用，不支持改 Dot 模型、注入本机 CLI 插件、回退、分叉或终端模式。专用 Dot 对话支持以文件附件上传图片；呼叫、Slack 和语音仍明确标为在 ChatGPT 操作。「＋」菜单支持本机附件、ChatGPT 链接、本机 Codex 和 Claude Code 的插件引用。它不把本机插件注入云端 Dot；原生 ChatGPT 账户目录需在官方页面选择。
- 审批和远端停止操作在 ChatGPT 完成。本地关闭仅断开观察，不会停止云端 Dot；能力表不宣称支持远端中断。
- 引擎会话轮询覆盖这次发送之后的回复及其任务卡片；Dot 对话另外读取最近历史和主动消息。不会在应用重启后自动恢复任务观察。远程桌面当前支持鼠标和普通键盘；中文输入法与剪贴板同步尚未实现。
- 2026-11-17 已通过真实 Pro 10x 账号的 Electron 只读联调：目录 1 个 Dot、身份验证、32 条历史、签名附件、环境 connected / remote_desktop ready，活动与任务接口返回空列表。真实消息发送和云端工作流的验收结果另见根目录 `TODO.md`；只读成功不代表这两项已经通过。

Dot 已读提示只读取经校验的房间原生 `read_receipts`；`last_read_at` 用于匹配发送消息，`read_cursor_updated_at` 用于显示已读时间。字段缺失时不从回复推断，不上报本机已读。原生字段参考：[公开桥接实现](https://github.com/beeper/chatgpt-dots/blob/562c0a9fe1b49336284af7714faa8c8d96dbf610/pkg/chatgpt/signals.go)。
