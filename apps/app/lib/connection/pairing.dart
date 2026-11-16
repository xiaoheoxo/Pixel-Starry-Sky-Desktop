// 配对过的一台电脑（同网页版 apps/mobile/src/connection/storage.ts 的 Pairing）。
// App 里整份存在系统钥匙串 / Keystore（storage.dart），手机长期私钥也在里面。
import '../link/link.dart';

enum PairingStatus {
  /// 等电脑上确认
  pending,

  /// 已配对
  paired,

  /// 被电脑移除（或令牌作废）：停止重连，提示重新配对
  removed;

  static PairingStatus parse(Object? v) => switch (v) {
    'paired' => paired,
    'removed' => removed,
    _ => pending,
  };
}

class Pairing {
  const Pairing({
    required this.deviceId,
    required this.token,
    required this.desktopId,
    required this.desktopName,
    required this.origin,
    this.relay,
    this.node,
    required this.desktopKey,
    required this.fingerprint,
    required this.phoneKey,
    required this.pairedAt,
    required this.status,
    this.request,
  });

  /// 云端分配的设备 ID（中转上的手机 ID）
  final String deviceId;

  /// 设备令牌（只能用于中转）
  final String token;
  final String desktopId;
  final String desktopName;

  /// 主站（https://…）：兑换配对码、列中转节点都在这里；没跟随节点时实时连接也连它
  final String origin;

  /// 二维码里的中转地址（只记下来，连哪里看 [node] 和 [origin]）
  final String? relay;

  /// 跟随的中转节点（主站 /v1/bridge/nodes 列出的、二维码里给的）
  final String? node;

  /// 电脑长期公钥（base64url）和指纹
  final String desktopKey;
  final String fingerprint;

  /// 手机长期私钥（base64url）
  final String phoneKey;
  final int pairedAt;
  final PairingStatus status;

  /// 等确认时要发给电脑的配对请求（电脑每次上线都再发一次）；确认后清掉
  final PairRequest? request;

  /// 实时连接的地址（同网页版 link.ts 的 relayUrl）
  Uri get relayUrl {
    final node = this.node;
    final base = node != null
        ? Uri.parse(node)
        : Uri.parse(origin).replace(
            scheme: Uri.parse(origin).scheme == 'https' ? 'wss' : 'ws',
            path: '/v1/bridge/ws',
          );
    return base.replace(queryParameters: {'role': 'phone'});
  }

  Pairing copyWith({PairingStatus? status, bool clearRequest = false}) =>
      Pairing(
        deviceId: deviceId,
        token: token,
        desktopId: desktopId,
        desktopName: desktopName,
        origin: origin,
        relay: relay,
        node: node,
        desktopKey: desktopKey,
        fingerprint: fingerprint,
        phoneKey: phoneKey,
        pairedAt: pairedAt,
        status: status ?? this.status,
        request: clearRequest ? null : request,
      );

  Map<String, Object?> toJson() => {
    'deviceId': deviceId,
    'token': token,
    'desktopId': desktopId,
    'desktopName': desktopName,
    'origin': origin,
    if (relay != null) 'relay': relay,
    if (node != null) 'node': node,
    'desktopKey': desktopKey,
    'fingerprint': fingerprint,
    'phoneKey': phoneKey,
    'pairedAt': pairedAt,
    'status': status.name,
    if (request != null) 'request': request!.toJson(),
  };

  /// 存储里读出来的；缺关键字段返回 null（丢掉这条）
  static Pairing? fromJson(Object? raw) {
    if (raw is! Map) return null;
    String? s(String k) => raw[k] is String ? raw[k] as String : null;
    final deviceId = s('deviceId'), token = s('token');
    final desktopId = s('desktopId'), origin = s('origin');
    final desktopKey = s('desktopKey'), phoneKey = s('phoneKey');
    if (deviceId == null ||
        token == null ||
        desktopId == null ||
        origin == null ||
        desktopKey == null ||
        phoneKey == null) {
      return null;
    }
    final req = raw['request'];
    return Pairing(
      deviceId: deviceId,
      token: token,
      desktopId: desktopId,
      desktopName: s('desktopName') ?? '',
      origin: origin,
      relay: s('relay'),
      node: s('node'),
      desktopKey: desktopKey,
      fingerprint: s('fingerprint') ?? '',
      phoneKey: phoneKey,
      pairedAt: raw['pairedAt'] is num ? (raw['pairedAt'] as num).toInt() : 0,
      status: PairingStatus.parse(raw['status']),
      request:
          req is Map &&
              req['key'] is String &&
              req['name'] is String &&
              req['mac'] is String
          ? PairRequest(
              key: req['key'] as String,
              name: req['name'] as String,
              mac: req['mac'] as String,
            )
          : null,
    );
  }
}
