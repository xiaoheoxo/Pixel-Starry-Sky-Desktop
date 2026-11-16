// 配对文字（二维码内容 / 配对链接）的解析（同网页版 apps/mobile/src/connection/offer.ts）。不碰存储和网络。
// 出错抛 OfferException，界面按 code 显示中英文说明。
import '../link/link.dart';

/// 二维码里的电脑信息（给配对页显示）
class Offer {
  const Offer({
    required this.raw,
    required this.text,
    required this.desktopName,
    required this.fingerprint,
    required this.expired,
  });
  final PairingOffer raw;

  /// 解析出它的那段文字（网页链接时取它的来源当主站）
  final String text;
  final String desktopName;
  final String fingerprint;
  final bool expired;

  /// 主站：网页链接的来源（码只在电脑申请它的主站进程里）；pixelsky:// 链接没有来源，用中转地址对应的主站
  String get origin {
    final u = Uri.tryParse(text);
    if (u != null && (u.isScheme('http') || u.isScheme('https'))) {
      return u.origin;
    }
    return bridgeApiBase(raw.relay);
  }
}

enum OfferError {
  /// 文字里没有配对链接
  notFound,

  /// 像是配对链接但不完整
  incomplete,

  /// 链接坏了
  invalid,

  /// 过期了（5 分钟有效）
  expired,
}

class OfferException implements Exception {
  const OfferException(this.error);
  final OfferError error;
  @override
  String toString() => 'OfferException(${error.name})';
}

/// 扫到的二维码文字（网页链接或 pixelsky://pair?d=…）；格式不对抛 LinkException
Offer parseOffer(String text, {DateTime? now}) {
  final raw = decodeOffer(text);
  return Offer(
    raw: raw,
    text: text,
    desktopName: raw.name,
    fingerprint: fingerprint(fromBase64Url(raw.key)),
    expired: (now ?? DateTime.now()).millisecondsSinceEpoch > raw.expires,
  );
}

// 配对链接的两种写法；数据部分是 base64url（字母数字 - _）
final _links = RegExp(
  r'''pixelsky://pair\?d=[A-Za-z0-9_-]+|https?://[^\s#<>"'“”‘’，。]*#pair=[A-Za-z0-9_-]+''',
  caseSensitive: false,
);
final _escaped = RegExp(r'%[0-9a-f]{2}', caseSensitive: false);
final _wrapped = RegExp(
  r'((?:#pair=|\?d=)[A-Za-z0-9_-]*)((?:[ \t]*\r?\n[ \t]*[A-Za-z0-9_-]+)+)',
  caseSensitive: false,
);
final _space = RegExp(r'\s+');
final _hint = RegExp(r'pair|pixelsky', caseSensitive: false);

String _unescape(String text) {
  if (!_escaped.hasMatch(text)) return text;
  try {
    return Uri.decodeComponent(text);
  } catch (_) {
    return text;
  }
}

/// 从粘贴的任意文字里找出配对链接并解析：前后可以有别的字，链接数据被聊天软件折行时补回去
Offer findOffer(String pasted, {DateTime? now}) {
  final text = _unescape(pasted);
  final unwrapped = text.replaceAllMapped(
    _wrapped,
    (m) => m[1]! + m[2]!.replaceAll(_space, ''),
  );
  final tokens = <String>[];
  for (final t in [text, unwrapped]) {
    for (final m in _links.allMatches(t)) {
      if (!tokens.contains(m[0])) tokens.add(m[0]!);
    }
  }
  if (tokens.isEmpty) {
    throw OfferException(
      _hint.hasMatch(text) ? OfferError.incomplete : OfferError.notFound,
    );
  }
  // 多个链接时取第一个能解开且没过期的；只有全都过期才报过期
  final offers = <Offer>[];
  for (final token in tokens) {
    try {
      offers.add(parseOffer(token, now: now));
    } on LinkException {
      // 换下一个候选
    }
  }
  if (offers.isEmpty) throw const OfferException(OfferError.invalid);
  for (final o in offers) {
    if (!o.expired) return o;
  }
  throw const OfferException(OfferError.expired);
}
