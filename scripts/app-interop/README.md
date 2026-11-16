# 手机 App 互通验证（Dart ↔ TS）

用途：确认手机 App 里的 Dart 版 `lib/link` 能和电脑端真实的网关代码说上话。TS 和 Dart 各自的单元测试读同一批样例（`apps/app/test/fixtures/`），但那只证明算法一致；这里让两边真的走一遍从配对到调用的完整链路。

## 怎么跑

```
node scripts/check.mjs --app                      # 随 App 的格式、静态检查、测试一起跑（步骤 app:interop）
node scripts/app-interop/run.mjs                  # 5 个场景全跑，约 20 秒
node scripts/app-interop/run.mjs ok tamper-down   # 只跑指定场景
node scripts/app-interop/run.mjs --serve          # 只起中转和电脑，打印配对链接，手动跑探针：
                                                  #   cd apps/app && dart run tool/link_probe.dart "<链接>"
```

需要 `dart` 在 PATH 上（或设环境变量 `DART`）。依赖只用仓库已装的 `ws`、`esbuild`，见 `deps.mjs`，不用另装。

打包产物和日志放 `scratch/<日期>-app-interop-<进程号>/`：全部通过就删掉；失败时保留，并在输出末尾打印路径（`run.log` 是完整输出，用完 `node scripts/clean-scratch.mjs` 清）。

## 场景

每个场景重新生成配对链接，起一次 `apps/app/tool/link_probe.dart`，核对探针退出码和电脑这边看到的结果。

| 场景           | 内容                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `ok`           | 完整流程：配对、握手、hello、会话列表、大回复（压缩）、事件批量、发大消息（压缩） |
| `wrong-secret` | 配对校验码用错的密钥算：电脑不回应，配对状态不变；没确认就握手，中转丢帧          |
| `wrong-key`    | 配对后换一把长期密钥握手：电脑回 `handshake_failed`；换回正确的密钥握手成功        |
| `tamper-down`  | 中转改坏发往手机的一个数据帧：手机通道作废，重新握手后恢复                         |
| `tamper-up`    | 中转改坏发往电脑的一个数据帧：电脑作废通道、不再回复，手机调用超时，重新握手后恢复 |

确认探针的检查有效：环境变量 `INTEROP_TAMPER=off` 让两个篡改场景不改帧（应该失败）；`INTEROP_TAMPER=phone:3` 或 `desktop:2` 让任何场景改第 n 个数据帧（对应场景应该失败）。

## 模拟了什么

- 电脑（`desktop.mjs`）：桌面端原样的 `MobileGateway`（`main/mobile/gateway.ts`）和 `RelayLink`（`main/mobile/relay.ts`），里面是 `packages/link` 的 Responder、SecureChannel、RpcCore；压缩照 `main/mobile/ipc.ts`。用 esbuild 打包后在 Node 里跑。
- 云端中转（`relay.mjs`）：照 `services/cloud` 的 `bridgeapi.go` 和 `bridge.go` 用 Node 写的：换令牌接口、WebSocket 子协议、先接受再核对令牌（错了用 4001 关）、Origin 规则、待确认的手机只放行配对请求、手机一侧加帧头转发、心跳、限流。另外多一个改坏某个方向第 n 个数据帧的开关（反例用）。

## 没模拟什么

- 不是真的云端：没跑 Go 中转（4001 每分钟复查令牌、4010 顶人、发送队列满没覆盖），主站的配对码、设备管理、优质节点都是假的。
- 不是 Electron 进程：网关和中转连接是真代码，存储（内存）、引擎（`engine:sessions` 等返回假数据）、「用户在电脑上点允许」（自动点）是假的。
- 没上真机或模拟器，探针在命令行跑 Dart VM，不经过 Flutter 界面。
- `pixelsky://` 配对链接、优质节点没走互通；心跳只收 1 次就退出，60 秒判断断线的逻辑没真等。
- `ok` 场景会对第一条会话调 `engine:send`（发一条测试消息），所以只能对模拟电脑跑，不要指到真实的电脑上。
