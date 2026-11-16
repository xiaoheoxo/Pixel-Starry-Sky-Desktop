// 扫码配对（照 packages/link/src/pairing.ts，docs/mobile-remote.md §4.1）。
// 二维码里有电脑的长期公钥和一次性密钥；手机用这个密钥给「自己的公钥 + 名字」算校验码，
// 电脑核对后才让用户确认。密钥只在二维码里，中转（以后是云端）拿不到，所以伪造不了配对请求。
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'bytes.dart';
import 'noise.dart';

const linkVersion = 1;

/// 握手前缀：协议版本绑进握手，两端版本不同时握手失败
final Uint8List prologue = toUtf8('pixelsky-mobile/1').asUnmodifiableView();

/// 二维码内容
class PairingOffer {
  const PairingOffer({
    this.v = linkVersion,
    required this.relay,
    required this.desktop,
    required this.key,
    required this.secret,
    required this.name,
    required this.expires,
    this.code,
  });

  final int v;

  /// 中转地址（ws:// 或 wss://）
  final String relay;

  /// 电脑 ID
  final String desktop;

  /// 电脑长期公钥（base64url）
  final String key;

  /// 一次性配对密钥（base64url，16 字节）
  final String secret;

  /// 电脑名，只用来显示
  final String name;

  /// 过期时间（毫秒时间戳）。JSON 里只要求是数字（同 TS），所以是 num
  final num expires;

  /// 云端的一次性配对码：手机用它换设备令牌（M2）；本机测试中转没有
  final String? code;

  /// 键的顺序同电脑端（gateway.ts）生成二维码时的顺序
  Map<String, Object?> toJson() => {
    'v': v,
    'relay': relay,
    'desktop': desktop,
    'key': key,
    'secret': secret,
    'name': name,
    'expires': expires,
    if (code != null) 'code': code,
  };
}

/// 手机发给电脑的配对请求
class PairRequest {
  const PairRequest({required this.key, required this.name, required this.mac});

  /// 手机长期公钥（base64url）
  final String key;

  /// 手机名，只用来显示
  final String name;

  /// HMAC-SHA256(配对密钥, 标签 | 电脑公钥 | 手机公钥 | 手机名)（base64url）
  final String mac;

  Map<String, Object?> toJson() => {'key': key, 'name': name, 'mac': mac};
}

/// 配对结果帧（明文、经云端，不可信）：只能用来更新界面和决定何时重试，不能据此删掉已配好的电脑。
/// - unknown：电脑上没有这部手机（被移除或电脑重装）；真被移除时云端会以 4001 关连接
/// - unavailable：电脑暂时拿不到自己的密钥（系统加密不可用）
/// - handshakeFailed：握手消息解不开，带上电脑的 LINK_VERSION 供手机判断版本不一致
enum PairStatus {
  pending('pending'),
  accepted('accepted'),
  rejected('rejected'),
  expired('expired'),
  unknown('unknown'),
  unavailable('unavailable'),
  handshakeFailed('handshake_failed');

  const PairStatus(this.wire);

  /// 线上的写法
  final String wire;

  /// 认不出的状态返回 null（结果帧不可信）
  static PairStatus? parse(Object? value) {
    for (final s in values) {
      if (s.wire == value) return s;
    }
    return null;
  }
}

final _label = toUtf8('pixelsky-pair/1');
const _nameLimit = 64;
final _random = Random.secure();

String newPairingSecret() =>
    toBase64Url(List.generate(16, (_) => _random.nextInt(256)));

Uint8List _mac(
  List<int> secret,
  List<int> desktopKey,
  List<int> phoneKey,
  String name,
) => hmacSha256(secret, concat([_label, desktopKey, phoneKey, toUtf8(name)]));

final _controls = RegExp(r'[\u0000-\u001f\u007f]');
// JS 的 trim：Dart 的 String.trim 还会去掉 U+0085，和 TS 不一致；RegExp 的 \s 和 JS 相同
final _edges = RegExp(r'^\s+|\s+$');

// 同 JS 的 String.prototype.trim
String _jsTrim(String text) => text.replaceAll(_edges, '');

/// 去掉控制字符、首尾空白，按 UTF-16 码元截到 64 个（同 TS 的 slice，可能截断代理对）
String _cleanName(Object? name) {
  if (name is! String) return '';
  final s = _jsTrim(name.replaceAll(_controls, ''));
  return s.length > _nameLimit ? s.substring(0, _nameLimit) : s;
}

/// 手机：按二维码生成配对请求
PairRequest pairRequest(
  PairingOffer offer,
  Uint8List phonePublicKey,
  String name,
) {
  final clean = _cleanName(name);
  return PairRequest(
    key: toBase64Url(phonePublicKey),
    name: clean,
    mac: toBase64Url(
      _mac(
        fromBase64Url(offer.secret),
        fromBase64Url(offer.key),
        phonePublicKey,
        clean,
      ),
    ),
  );
}

/// 电脑：核对配对请求，通过时返回手机公钥和名字，不通过时返回 null（App 里不用，留着做互通测试）
({Uint8List publicKey, String name})? verifyPairRequest(
  Object? raw,
  String secret,
  Uint8List desktopPublicKey,
) {
  // 只有对象才可能带字符串的 key 和 mac（TS 里 null、数组、字符串都落到下面返回 null）
  if (raw is! Map) return null;
  try {
    final key = raw['key'], mac = raw['mac'];
    if (key is! String || mac is! String) return null;
    final publicKey = fromBase64Url(key);
    final name = _cleanName(raw['name']);
    if (publicKey.length != keyLength || name != raw['name']) return null;
    final expected = _mac(
      fromBase64Url(secret),
      desktopPublicKey,
      publicKey,
      name,
    );
    return equalBytes(expected, fromBase64Url(mac))
        ? (publicKey: publicKey, name: name)
        : null;
  } catch (_) {
    return null;
  }
}

final _hashTail = RegExp(r'#.*$');

/// 二维码文本。给了 [web]（手机网页版的地址）时是网页链接 web#pair=<数据>，用相机扫码直接打开网页版；
/// 没给时是 pixelsky://pair?d=<数据>（App 用）。电脑端生成，这里留着做互通测试
String encodeOffer(PairingOffer offer, [String? web]) {
  final data = toBase64Url(toUtf8(jsonEncode(offer.toJson())));
  return web != null && web.isNotEmpty
      ? '${web.replaceFirst(_hashTail, '')}#pair=$data'
      : 'pixelsky://pair?d=$data';
}

final _appLink = RegExp(r'^pixelsky://pair\?d=([A-Za-z0-9_-]+)$');
final _webLink = RegExp(r'^https?://[^#\s]*#pair=([A-Za-z0-9_-]+)$');
final _relay = RegExp(r'^wss?://');

/// 解析二维码文本；格式不对抛 LINK_BAD_OFFER。JSON 里多出的字段忽略
PairingOffer decodeOffer(String text) {
  final t = _jsTrim(text);
  final m = _appLink.firstMatch(t) ?? _webLink.firstMatch(t);
  if (m == null) throw const LinkException('LINK_BAD_OFFER');
  final Object? parsed;
  try {
    parsed = jsonDecode(fromUtf8(fromBase64Url(m[1]!)));
  } catch (_) {
    throw const LinkException('LINK_BAD_OFFER');
  }
  if (parsed is! Map) throw const LinkException('LINK_BAD_OFFER');
  final v = parsed['v'], relay = parsed['relay'], desktop = parsed['desktop'];
  final key = parsed['key'], secret = parsed['secret'], name = parsed['name'];
  final expires = parsed['expires'], code = parsed['code'];
  // code 可以没有，但写了 null 不行（TS 判断的是 undefined）
  final ok =
      v is num &&
      v == linkVersion &&
      relay is String &&
      _relay.hasMatch(relay) &&
      desktop is String &&
      key is String &&
      secret is String &&
      name is String &&
      expires is num &&
      (!parsed.containsKey('code') || code is String);
  if (!ok) throw const LinkException('LINK_BAD_OFFER');
  return PairingOffer(
    relay: relay,
    desktop: desktop,
    key: key,
    secret: secret,
    name: name,
    expires: expires,
    code: code as String?,
  );
}

/// 公钥指纹：两端各显示一份，用户可以对一下（4 组 4 位十六进制）
String fingerprint(Uint8List publicKey) {
  final h = toHex(sha256(publicKey).sublist(0, 8)).toUpperCase();
  return [for (var i = 0; i < h.length; i += 4) h.substring(i, i + 4)]
      .join('·');
}

final _relayHost = RegExp(r'^(wss?)://([^/?#]+)');

/// 中转地址对应的云端接口地址：wss://host/v1/bridge/ws → https://host（手机用配对码换设备令牌时用）
String bridgeApiBase(String relay) {
  final m = _relayHost.firstMatch(relay);
  if (m == null) throw const LinkException('LINK_BAD_OFFER');
  return '${m[1] == 'wss' ? 'https://' : 'http://'}${m[2]}';
}

/// 连中转时带令牌的子协议（同网页版：浏览器的 WebSocket 不能加请求头）
const bridgeProtocol = 'pixelsky.v1';
List<String> bridgeProtocols(String token) => [bridgeProtocol, 'bearer.$token'];
