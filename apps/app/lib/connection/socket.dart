// 到中转的 WebSocket：抽成接口，测试里换成内存里的假中转（test/connection/fake_relay.dart）。
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'route.dart';

abstract interface class RelaySocket {
  /// 收到文本（String）或二进制（Uint8List）；断开时 onDone 带关闭码（没有时 null）
  void listen(
    void Function(Object message) onMessage, {
    required void Function(int? code) onDone,
  });
  void send(Object data);
  void close();
}

typedef SocketFactory = Future<RelaySocket> Function(
  Uri url,
  List<String> protocols,
);

/// dart:io 的实现：令牌放在子协议里，不带 Origin；帧都是密文，不协商 permessage-deflate
Future<RelaySocket> connectRelay(
  Uri url,
  List<String> protocols, {
  HttpClient? client,
  Duration timeout = const Duration(seconds: 20),
}) async {
  final ws = await WebSocket.connect(
    url.toString(),
    protocols: protocols,
    compression: CompressionOptions.compressionOff,
    customClient: client,
  ).timeout(timeout);
  // 中转每 20 秒发一条文本心跳；底层 ping 让系统更早发现断线
  ws.pingInterval = const Duration(seconds: 25);
  return _IoSocket(ws);
}

class _IoSocket implements RelaySocket {
  _IoSocket(this._ws);
  final WebSocket _ws;
  StreamSubscription<dynamic>? _sub;

  @override
  void listen(
    void Function(Object message) onMessage, {
    required void Function(int? code) onDone,
  }) {
    _sub = _ws.listen(
      (data) {
        if (data is String) {
          onMessage(data);
        } else if (data is List<int>) {
          onMessage(data is Uint8List ? data : Uint8List.fromList(data));
        }
      },
      onDone: () => onDone(_ws.closeCode),
      onError: (Object _) => onDone(_ws.closeCode),
      cancelOnError: true,
    );
  }

  @override
  void send(Object data) {
    if (_ws.readyState == WebSocket.open) _ws.add(data);
  }

  @override
  void close() {
    _ws.close().catchError((Object _) {});
    // 死连接上关闭握手可能很久才完成：不等它，立刻不再收消息
    _sub?.cancel();
  }
}

/// 按线路连中转（docs/mobile-app.md §20）：正式站按 CDN → 直连 → IP 依次试，每档最多等 8 秒；别的地址直接连
Future<RelaySocket> connectRouted(
  Uri url,
  List<String> protocols, {
  RouteState? route,
}) {
  if (!isOfficialHost(url.host)) return connectRelay(url, protocols);
  return (route ?? appRoute).run((tier) async {
    final client = clientFor(tier)..connectionTimeout = tierTimeout;
    try {
      return await connectRelay(
        tierUrl(url, tier),
        protocols,
        client: client,
        timeout: tierTimeout,
      );
    } finally {
      // 升级后的连接已经从 HttpClient 拿出来了，关掉 HttpClient 不影响它
      client.close();
    }
  }, realtime: true);
}
