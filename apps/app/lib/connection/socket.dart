// 到中转的 WebSocket：抽成接口，测试里换成内存里的假中转（test/connection/fake_relay.dart）。
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

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
}) async {
  final ws = await WebSocket.connect(
    url.toString(),
    protocols: protocols,
    compression: CompressionOptions.compressionOff,
    customClient: client,
  ).timeout(const Duration(seconds: 20));
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
