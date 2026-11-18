// 扫码后：生成手机密钥，用配对码向主站换设备令牌，记下来等电脑上确认（同网页版 connection/index.ts 的 pairWithOffer）。
// 配对码在电脑申请它的主站进程内存里，所以总在主站兑换；二维码里的中转是主站列出的节点（优质节点）就记下来，之后的实时连接走那个节点。
import 'dart:convert';
import 'dart:io';

import '../app/log.dart';
import '../link/link.dart';
import 'nodes.dart';
import 'offer.dart';
import 'pairing.dart';

enum PairError {
  /// 二维码不是经云端配对的（没有配对码）
  notCloud,

  /// 连不上云端
  network,

  /// 二维码已过期或已经用过
  invalidCode,

  /// 这台电脑配对的手机满了
  tooManyDevices,

  /// 其他失败
  failed,
}

class PairException implements Exception {
  const PairException(this.error);
  final PairError error;
  @override
  String toString() => 'PairException(${error.name})';
}

/// 主站的两个接口；测试里换成假的
abstract interface class BridgeApi {
  Future<Object?> getJson(Uri url);

  /// 返回 HTTP 状态码和 JSON 内容（解析不了时为 null）
  Future<({int status, Object? body})> postJson(Uri url, Object body);
}

class IoBridgeApi implements BridgeApi {
  IoBridgeApi([HttpClient? client]) : _client = client ?? HttpClient();
  final HttpClient _client;

  @override
  Future<Object?> getJson(Uri url) async {
    final req = await _client.getUrl(url);
    req.headers.set(HttpHeaders.acceptHeader, 'application/json');
    final res = await req.close().timeout(const Duration(seconds: 15));
    final text = await res.transform(utf8.decoder).join();
    return res.statusCode == 200 ? decodeJsonBody(text) : null;
  }

  @override
  Future<({int status, Object? body})> postJson(Uri url, Object body) async {
    final req = await _client.postUrl(url);
    req.headers.contentType = ContentType.json;
    req.write(jsonEncode(body));
    final res = await req.close().timeout(const Duration(seconds: 15));
    final text = await res.transform(utf8.decoder).join();
    return (status: res.statusCode, body: decodeJsonBody(text));
  }
}

Future<Pairing> pairWithOffer(
  Offer offer,
  String phoneName,
  BridgeApi api, {
  DateTime? now,
}) async {
  final code = offer.raw.code;
  if (code == null) throw const PairException(PairError.notCloud);
  final origin = offer.origin;
  final key = generateKeypair();
  String? node;
  ({int status, Object? body}) res;
  try {
    node = await pickNode(offer.raw.relay, origin, api.getJson);
    res = await api.postJson(Uri.parse('$origin/v1/bridge/pair'), {
      'code': code,
      'name': phoneName,
    });
  } catch (e) {
    appLog.warn('配对', '连不上云端：$e');
    throw const PairException(PairError.network);
  }
  final body = res.body is Map ? res.body as Map : const {};
  final deviceId = body['deviceId'], token = body['token'];
  if (res.status != 200 && res.status != 201 ||
      deviceId is! String ||
      token is! String) {
    appLog.warn('配对', '云端回 ${res.status}：${body['error'] ?? '没有设备号'}');
    throw PairException(switch (body['error']) {
      'invalid_code' => PairError.invalidCode,
      'too_many_devices' => PairError.tooManyDevices,
      _ => PairError.failed,
    });
  }
  return Pairing(
    deviceId: deviceId,
    token: token,
    desktopId: offer.raw.desktop,
    desktopName: offer.desktopName,
    origin: origin,
    relay: offer.raw.relay,
    node: node,
    desktopKey: offer.raw.key,
    fingerprint: offer.fingerprint,
    phoneKey: toBase64Url(key.privateKey),
    pairedAt: (now ?? DateTime.now()).millisecondsSinceEpoch,
    status: PairingStatus.pending,
    request: pairRequest(offer.raw, key.publicKey, phoneName),
  );
}

/// 手机自己的指纹（配对时和电脑上显示的对一下）
String phoneFingerprint(Pairing p) =>
    fingerprint(keypairFrom(fromBase64Url(p.phoneKey)).publicKey);
