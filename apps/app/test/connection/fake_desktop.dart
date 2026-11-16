// 内存里的假中转 + 假电脑：照电脑端 relay.ts / gateway.ts 的行为（配对请求、握手、加密通道、hello、事件），
// 让 DesktopLink 的状态机不经过网络就能测。和真电脑端的互通由 scripts/app-interop 另外验证。
import 'dart:async';
import 'dart:typed_data';

import 'package:pixelsky_app/connection/socket.dart';
import 'package:pixelsky_app/link/link.dart';

class FakeSocket implements RelaySocket {
  FakeSocket(this.desktop);
  final FakeDesktop desktop;
  void Function(Object message)? _onMessage;
  void Function(int? code)? _onDone;
  bool closed = false;

  @override
  void listen(
    void Function(Object message) onMessage, {
    required void Function(int? code) onDone,
  }) {
    _onMessage = onMessage;
    _onDone = onDone;
  }

  @override
  void send(Object data) {
    if (closed) return;
    desktop.fromPhone(this, data as Uint8List);
  }

  @override
  void close() => closed = true;

  /// 中转发给手机（异步，同真网络）
  void deliver(Object message) => scheduleMicrotask(() {
    if (!closed) _onMessage?.call(message);
  });

  /// 中转关闭连接
  void drop(int code) {
    if (closed) return;
    closed = true;
    scheduleMicrotask(() => _onDone?.call(code));
  }
}

class FakeDesktop {
  FakeDesktop({required this.secret, this.online = true});

  final Keypair key = generateKeypair();
  final String secret;
  bool online;

  /// 配对：电脑上点允许 / 拒绝之前停在 pending
  bool autoAccept = true;
  bool reject = false;

  /// 已确认的手机公钥
  final known = <String>{};
  int handshakes = 0;
  final calls = <String>[];
  num helloVersion = linkVersion;

  /// 不回 Handshake2（测握手超时）
  bool silentHandshake = false;

  /// 握手时回这个状态而不是 Handshake2
  String? handshakeReply;

  FakeSocket? socket;
  SecureChannel? _channel;
  RpcCore? _rpc;
  final sockets = <FakeSocket>[];

  /// 中转接受一条手机连接（connect 工厂里用）
  Future<RelaySocket> accept(Uri url, List<String> protocols) async {
    final s = FakeSocket(this);
    sockets.add(s);
    socket = s;
    if (online) {
      Timer.run(() => s.deliver('{"type":"desktop_online"}'));
    }
    return s;
  }

  void goOnline() {
    online = true;
    socket?.deliver('{"type":"desktop_online"}');
  }

  void goOffline() {
    online = false;
    _channel = null;
    _rpc = null;
    socket?.deliver('{"type":"desktop_offline"}');
  }

  void tick() => socket?.deliver('{"type":"tick"}');

  void _result(FakeSocket s, Map<String, Object?> body) =>
      s.deliver(encodeFrame(FrameType.pairResult, encodeJson(body)));

  void fromPhone(FakeSocket s, Uint8List frame) {
    if (!online) return;
    final f = decodeFrame(frame);
    switch (f.type) {
      case FrameType.pair:
        final ok = verifyPairRequest(decodeJson(f.body), secret, key.publicKey);
        if (ok == null) return;
        _pendingKey = toBase64Url(ok.publicKey);
        if (reject) {
          _result(s, {'status': 'rejected'});
        } else if (autoAccept) {
          accept1(s);
        } else {
          _result(s, {'status': 'pending'});
        }
      case FrameType.handshake1:
        handshakes++;
        if (silentHandshake) return;
        if (handshakeReply != null) {
          _result(s, {'status': handshakeReply, 'v': linkVersion});
          return;
        }
        for (final phone in known) {
          try {
            final r = Responder(
              local: key,
              remote: fromBase64Url(phone),
              prologue: prologue,
            );
            r.readMessage1(f.body);
            final out = r.writeMessage2();
            s.deliver(encodeFrame(FrameType.handshake2, out.message));
            _open(s, out.result);
            return;
          } on LinkException {
            // 换下一部手机试
          }
        }
        _result(s, {'status': 'unknown'});
      case FrameType.data:
        _channel?.receive(f.body);
      case FrameType.handshake2 || FrameType.pairResult:
        break;
    }
  }

  String? _pendingKey;

  /// 电脑上点「允许」
  void accept1(FakeSocket s) {
    known.add(_pendingKey!);
    _result(s, {'status': 'accepted'});
  }

  void _open(FakeSocket s, HandshakeResult keys) {
    late final SecureChannel channel;
    final rpc = RpcCore(
      (m) => channel.send(m).catchError((Object _) {}),
      handler: (method, args) {
        calls.add(method);
        return switch (method) {
          'hello' => {
            'version': helloVersion,
            'name': '测试电脑',
            'access': 'act',
            'tools': true,
          },
          'engine:sessions' => [
            {'id': 's1'},
          ],
          'away' => null,
          'slow' => Completer<Object?>().future,
          _ => throw const LinkException('Unknown RPC method'),
        };
      },
    );
    channel = SecureChannel(
      keys,
      output: s.deliver,
      onMessage: rpc.receive,
      onError: (_) {},
      codec: deflateRawCodec,
    );
    _channel = channel;
    _rpc = rpc;
  }

  /// 电脑推事件
  void event(String name, Object? data) => _rpc?.event(name, data);

  /// 电脑悄悄丢掉加密会话（重启 / 篡改后作废）
  void forgetSession() {
    _channel = null;
    _rpc = null;
  }
}
