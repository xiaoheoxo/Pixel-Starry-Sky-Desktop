// 经中转的帧（照 packages/link/src/frame.ts，docs/mobile-remote.md §11.3）：第 1 字节是类型，后面是内容。
// 中转只按连接转发，看不懂内容；只有配对请求和结果是明文，其余都在加密通道里。
import 'dart:convert';
import 'dart:typed_data';

import 'bytes.dart';

/// 按类型字节从 1 开始排，decodeFrame 靠这个顺序查
enum FrameType {
  /// 手机 → 电脑：Noise 握手第一条
  handshake1(1),

  /// 电脑 → 手机：Noise 握手第二条
  handshake2(2),

  /// 加密后的数据
  data(3),

  /// 手机 → 电脑：配对请求（明文 JSON，带用二维码里的密钥算的校验码）
  pair(4),

  /// 电脑 → 手机：配对结果（明文 JSON；不可信，只用来显示，真正的校验是之后的握手）
  pairResult(5);

  const FrameType(this.value);

  /// 线上的类型字节
  final int value;
}

/// 中转的单帧上限是 1 MB；留出加密和帧头的余量
const maxFrame = 1024 * 1024;
const maxPayload = maxFrame - 1024;

Uint8List encodeFrame(FrameType type, List<int> body) {
  if (body.length + 1 > maxFrame) {
    throw const LinkException('LINK_FRAME_TOO_LARGE');
  }
  return concat([
    [type.value],
    body,
  ]);
}

/// 返回的 body 是 [frame] 的视图，不复制
({FrameType type, Uint8List body}) decodeFrame(Uint8List frame) {
  if (frame.isEmpty ||
      frame.length > maxFrame ||
      frame[0] < 1 ||
      frame[0] > FrameType.values.length) {
    throw const LinkException('LINK_BAD_FRAME');
  }
  return (
    type: FrameType.values[frame[0] - 1],
    body: Uint8List.sublistView(frame, 1),
  );
}

Uint8List encodeJson(Object? value) => toUtf8(jsonEncode(value));

Object? decodeJson(List<int> bytes) {
  try {
    return jsonDecode(fromUtf8(bytes));
  } catch (_) {
    throw const LinkException('LINK_BAD_FRAME');
  }
}
