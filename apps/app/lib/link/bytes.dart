// 字节工具（照 packages/link/src/bytes.ts）：base64url、十六进制、UTF-8、拼接、等长比较。
import 'dart:convert';
import 'dart:typed_data';

/// 协议里的错误：[message] 就是错误码（LINK_BAD_FRAME 等），和 TS 那边 Error.message 一致，两端按它判断。
class LinkException implements Exception {
  const LinkException(this.message);

  final String message;

  @override
  String toString() => message;
}

Uint8List concat(List<List<int>> parts) {
  final out = Uint8List(parts.fold(0, (n, p) => n + p.length));
  var offset = 0;
  for (final p in parts) {
    out.setAll(offset, p);
    offset += p.length;
  }
  return out;
}

/// 单独的代理项编成 EF BF BD，同 TextEncoder
Uint8List toUtf8(String text) => utf8.encode(text);

/// 严格解码（坏字节抛 FormatException），开头的一个 BOM 去掉：同 TS 的 TextDecoder('utf-8', { fatal: true })
String fromUtf8(List<int> bytes) => utf8.decode(bytes);

String toHex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

const _b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
final _b64Text = RegExp(r'^[A-Za-z0-9_-]*$');

/// base64url，不带填充（放进二维码和 JSON）
String toBase64Url(List<int> bytes) {
  final out = StringBuffer();
  for (var i = 0; i < bytes.length; i += 3) {
    final n =
        (bytes[i] << 16) |
        ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8) |
        (i + 2 < bytes.length ? bytes[i + 2] : 0);
    out
      ..write(_b64[(n >> 18) & 63])
      ..write(_b64[(n >> 12) & 63]);
    if (i + 1 < bytes.length) out.write(_b64[(n >> 6) & 63]);
    if (i + 2 < bytes.length) out.write(_b64[n & 63]);
  }
  return out.toString();
}

/// 只认 base64url 字母、不带填充；末尾多出的位直接丢掉（同 TS，不要求规范形式）
Uint8List fromBase64Url(String text) {
  if (!_b64Text.hasMatch(text) || text.length % 4 == 1) {
    throw const LinkException('LINK_BAD_ENCODING');
  }
  final out = Uint8List(text.length * 3 ~/ 4);
  var bits = 0, value = 0, o = 0;
  for (final unit in text.codeUnits) {
    // 只用到低 14 位，截断免得一直左移变大
    value = ((value << 6) | _b64.indexOf(String.fromCharCode(unit))) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 255;
    }
  }
  return out;
}

/// 等长比较，耗时不随第一个不同字节的位置变化
bool equalBytes(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff == 0;
}
