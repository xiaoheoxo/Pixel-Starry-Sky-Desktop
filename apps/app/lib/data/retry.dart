// 发送失败后重试沿用同一个 clientMessageId（同网页版 apps/mobile/src/data/retry.ts）：消息可能已经进了电脑上的队列、
// 只是回应丢了（断线、超时），换新 ID 电脑就认不出是重复，同一句话会执行两次。内容变了或发送成功后才换新的。
import 'dart:convert';
import 'dart:math';

class SendAttempt {
  const SendAttempt(this.key, this.id);

  /// 这次发的是什么（目标、文字、附件）
  final String key;
  final String id;
}

String sendKey(String target, String text, List<String> attachmentIds) =>
    jsonEncode([target, text, attachmentIds]);

/// 同样的内容沿用上次的 ID，否则换新的
SendAttempt attemptFor(
  SendAttempt? last,
  String key,
  String Function() newId,
) => last != null && last.key == key ? last : SendAttempt(key, newId());

final _random = Random.secure();

/// 随机 UUID v4（电脑用它给消息去重）
String uuid() {
  final b = List<int>.generate(16, (_) => _random.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}
