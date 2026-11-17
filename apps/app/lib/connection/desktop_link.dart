// 到一台电脑的连接（照网页版 apps/mobile/src/connection/link.ts，docs/mobile-remote.md §13.3）：
// 连云端中转 → （没配对完时）发配对请求 → Noise 握手 → 加密通道 + RPC。
// 和网页版的差别（docs/mobile-app.md A1）：中转地址来自配对记录（主站或跟随的节点），WebSocket 不协商压缩，
// 调用超时时探一下 hello，电脑那边悄悄丢了加密会话就马上重新握手（网页版要等回到前台）。
import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:clock/clock.dart';

import '../link/link.dart';
import 'pairing.dart';
import 'socket.dart';

enum LinkState {
  /// 正在连中转
  connecting,

  /// 中转连上了，电脑不在线（关机、睡眠、没开手机连接）
  desktopOffline,

  /// 扫码后等电脑上确认
  waitingConfirm,
  handshaking,
  ready,

  /// 被电脑移除，或令牌作废：不再重连，要重新扫码
  removed,

  /// 电脑说没有这部手机的配对；结果帧不可信，不删配对，过一会儿再试
  unrecognized,

  /// 电脑版和手机版的连接协议版本不一致
  incompatible,

  /// 连不上中转（没网），稍后自动重试
  offline,

  /// 账号的远程席位用满，被新连上的设备顶掉（4010）：不自动重连，点「重新连接」才连
  replaced,
}

/// hello 的回复
class Hello {
  const Hello({
    required this.version,
    required this.name,
    required this.access,
    this.tools = false,
    this.queueMoveBefore = false,
  });
  final num version;
  final String name;

  /// view：只看；act：能操作
  final String access;

  /// 电脑能给手机用 Git / 文件 / 产物 / 任务工具、加项目；旧版电脑没有
  final bool tools;

  /// 电脑认得队列调序的 { before: 消息 id | null }
  final bool queueMoveBefore;

  static Hello parse(Object? raw) {
    final m = raw is Map ? raw : const {};
    return Hello(
      version: m['version'] is num ? m['version'] as num : -1,
      name: m['name'] is String ? m['name'] as String : '',
      access: m['access'] == 'act' ? 'act' : 'view',
      tools: m['tools'] == true,
      queueMoveBefore: m['queueMoveBefore'] == true,
    );
  }
}

/// 电脑把流式增量打包成一帧发来的样子（gateway.ts 的 flush）
List<Object?> unbatch(Object? data) =>
    data is Map && data['kind'] == 'batch' && data['events'] is List
    ? data['events'] as List<Object?>
    : [data];

/// 握手时告诉电脑：能拆开打包成一帧的多个事件
const _hello = {'batch': true};

/// 中转关闭码（services/cloud/internal/bridge）：令牌失效
const closeUnauthorized = 4001;

/// 被同账号新连上的设备顶掉（docs/cloud-admin-seats-plan.md §3）
const closeReplaced = 4010;

class LinkTimings {
  const LinkTimings({
    this.handshakeTimeout = const Duration(seconds: 10),
    this.retrySoon = const Duration(seconds: 10),
    this.retryLater = const Duration(seconds: 60),
    this.deadAfter = const Duration(seconds: 60),
    this.callTimeout = const Duration(seconds: 20),
    this.helloTimeout = const Duration(seconds: 10),
    this.firstDelay = const Duration(seconds: 1),
    this.maxDelay = const Duration(seconds: 30),
  });

  /// 发出握手后这么久还没到 ready：断开重连
  final Duration handshakeTimeout;

  /// 电脑暂时不能握手 / 握手失败后多久再试
  final Duration retrySoon;

  /// 电脑说不认识这部手机后多久再试（真被移除时云端会 4001）
  final Duration retryLater;

  /// 云端每 20 秒发一条文本心跳；收到过之后这么久什么都没收到，就当连接已经死了
  final Duration deadAfter;
  final Duration callTimeout;
  final Duration helloTimeout;
  final Duration firstDelay;
  final Duration maxDelay;
}

class LinkHooks {
  const LinkHooks({
    required this.onState,
    required this.onEvent,
    required this.onPairing,
  });
  final void Function(LinkState state) onState;

  /// 电脑推来的事件：通道名 + 内容（批量的已拆开）
  final void Function(String channel, Object? data) onEvent;

  /// 配对状态变了（确认 / 移除），要存下来
  final void Function(Pairing pairing) onPairing;
}

class LinkNotReady implements Exception {
  const LinkNotReady();
  @override
  String toString() => 'MOBILE_NOT_READY';
}

class DesktopLink {
  DesktopLink(
    this.pairing,
    this._hooks, {
    required this._connect,
    this.timings = const LinkTimings(),
    Random? random,
  }) : _random = random ?? Random();

  Pairing pairing;
  final LinkHooks _hooks;
  final SocketFactory _connect;
  final LinkTimings timings;
  final Random _random;

  LinkState state = LinkState.connecting;
  Hello? hello;

  /// 断开后连续重连了几次（连上清零），断线横幅写「第几次」
  int retries = 0;

  /// 下一次自动重连的时间；没排着时为 null
  DateTime? retryAt;

  RelaySocket? _ws;
  RpcCore? _rpc;
  SecureChannel? _channel;
  Initiator? _initiator;
  Timer? _timer;

  /// 握手超时、稍后重试握手：换连接、停止、到 ready 时清掉
  Timer? _guard;
  Timer? _watchdog;
  late Duration _delay = timings.firstDelay;
  bool _stopped = true;

  void start() {
    if (!_stopped || pairing.status == PairingStatus.removed) return;
    _stopped = false;
    _open();
  }

  void stop() {
    _stopped = true;
    _timer?.cancel();
    _unguard();
    _reset();
    _drop();
  }

  /// 被顶掉后用户点「重新连接」：重新连上（会顶掉别的设备）
  void reconnect() {
    if (pairing.status == PairingStatus.removed || !_stopped) return;
    _timer?.cancel();
    _stopped = false;
    _delay = timings.firstDelay;
    _open();
  }

  /// 回到前台 / 点「立即重试」：没连着就马上重连，连着就探一下
  void wake() {
    if (_stopped) return;
    if (_ws == null) {
      _timer?.cancel();
      _delay = timings.firstDelay;
      _open();
    } else if (state == LinkState.ready) {
      _probe();
    }
  }

  /// 切到后台 / 回到前台：告诉电脑，后台时它照样推送提醒（旧版电脑不认，不管报错）
  void away(bool hidden) {
    if (state == LinkState.ready) {
      call('away', [hidden]).catchError((Object _) => null);
    }
  }

  /// timeout：等得久的调用（旁聊要等 AI 回答）另给；默认 timings.callTimeout
  Future<Object?> call(
    String method, [
    List<Object?> args = const [],
    Duration? timeout,
  ]) {
    final rpc = _rpc;
    if (rpc == null || state != LinkState.ready) {
      return Future.error(const LinkNotReady());
    }
    return rpc.call(method, args, timeout ?? timings.callTimeout).catchError((
      Object e,
    ) {
      // 超时可能是电脑那边悄悄丢了加密会话（篡改 / 电脑重启）：探一下，不通就重新握手
      if (e is LinkException && e.message.startsWith('RPC_TIMEOUT')) {
        if (identical(_rpc, rpc)) _probe();
      }
      throw e;
    });
  }

  void _probe() {
    final rpc = _rpc;
    if (rpc == null) return;
    rpc
        .call('hello', [_hello], timings.helloTimeout)
        .then(
          (_) {},
          onError: (Object _) {
            // 探的期间已经换了加密会话（重新握手）就别动新的
            if (identical(_rpc, rpc)) _handshake();
          },
        );
  }

  void _unguard() {
    _guard?.cancel();
    _guard = null;
  }

  /// 在当前连接上过一会儿重新握手（连接换了就作废）
  void _retryHandshake(Duration wait) {
    _unguard();
    final ws = _ws;
    _guard = Timer(wait, () {
      _guard = null;
      if (identical(_ws, ws) && !_stopped) _handshake();
    });
  }

  void _set(LinkState next) {
    if (state == next) return;
    if (next == LinkState.ready) {
      retries = 0;
      retryAt = null;
    }
    state = next;
    _hooks.onState(next);
  }

  void _reset() {
    _rpc?.close();
    _rpc = null;
    _channel = null;
    _initiator = null;
    hello = null;
  }

  void _drop() {
    _watchdog?.cancel();
    _watchdog = null;
    final ws = _ws;
    _ws = null;
    ws?.close();
  }

  void _open() {
    retryAt = null;
    _unguard();
    _reset();
    _drop();
    _set(LinkState.connecting);
    final pending = _connect(pairing.relayUrl, bridgeProtocols(pairing.token));
    // 用一个占位记下「正在连的这一次」：连上之前又 stop / open 了就丢掉
    final attempt = Object();
    _attempt = attempt;
    pending.then(
      (ws) {
        if (!identical(_attempt, attempt) || _stopped) {
          ws.close();
          return;
        }
        _attach(ws);
      },
      onError: (Object _) {
        if (identical(_attempt, attempt)) _lost(null, 0);
      },
    );
  }

  Object? _attempt;

  void _attach(RelaySocket ws) {
    _ws = ws;
    _delay = timings.firstDelay;
    // 老版本云端不发心跳：没收到过就不判断。后台被挂起回来时也靠它发现连接早断了
    DateTime? lastSeen;
    _watchdog = Timer.periodic(timings.deadAfter ~/ 4, (_) {
      if (!identical(_ws, ws)) return;
      final seen = lastSeen;
      if (seen != null && clock.now().difference(seen) > timings.deadAfter) {
        _lost(ws, 0);
      }
    });
    ws.listen((message) {
      if (!identical(_ws, ws)) return;
      if (lastSeen != null) lastSeen = clock.now();
      if (message is String) {
        if (message == '{"type":"tick"}') {
          lastSeen = clock.now();
        } else {
          _onNotice(message);
        }
      } else if (message is Uint8List) {
        _onFrame(message);
      }
    }, onDone: (code) => _lost(ws, code ?? 0));
  }

  /// 连接断了（或心跳超时当作断了；死连接上关闭可能很久才回调，不等它）
  void _lost(RelaySocket? ws, int code) {
    if (ws != null && !identical(_ws, ws)) return;
    _attempt = null;
    _drop();
    _unguard();
    _reset();
    if (code == closeUnauthorized) return _removed();
    if (_stopped) return;
    if (code == closeReplaced) {
      // 不自动重连：两台设备会来回互顶
      _stopped = true;
      _set(LinkState.replaced);
      return;
    }
    final wait = _delay * (0.8 + _random.nextDouble() * 0.4);
    retries++;
    retryAt = clock.now().add(wait);
    _set(LinkState.offline);
    _timer?.cancel();
    _timer = Timer(wait, _open);
    final doubled = _delay * 2;
    _delay = doubled > timings.maxDelay ? timings.maxDelay : doubled;
  }

  void _removed() {
    _stopped = true;
    _reset();
    _drop();
    pairing = pairing.copyWith(status: PairingStatus.removed);
    _hooks.onPairing(pairing);
    _set(LinkState.removed);
  }

  void _send(FrameType type, List<int> body) =>
      _ws?.send(encodeFrame(type, body));

  void _onNotice(String text) {
    Object? type;
    try {
      final v = jsonDecode(text);
      if (v is Map) type = v['type'];
    } on FormatException {
      return;
    }
    if (type == 'desktop_offline') {
      // 排着的重试握手、握手超时也作废：不然电脑不在线时还会去握手，状态来回闪
      _unguard();
      _reset();
      _set(LinkState.desktopOffline);
    } else if (type == 'desktop_online') {
      // 电脑（重新）上线：它那边的加密会话没了，重新握手；还没确认的再发一次配对请求
      if (pairing.status == PairingStatus.pending) {
        _sendPair();
      } else {
        _handshake();
      }
    }
  }

  void _sendPair() {
    final request = pairing.request;
    if (request == null) return;
    _send(FrameType.pair, encodeJson(request.toJson()));
    _set(LinkState.waitingConfirm);
  }

  void _handshake() {
    _reset();
    final initiator = Initiator(
      local: keypairFrom(fromBase64Url(pairing.phoneKey)),
      remote: fromBase64Url(pairing.desktopKey),
      prologue: prologue,
    );
    _initiator = initiator;
    _send(FrameType.handshake1, initiator.writeMessage1());
    _set(LinkState.handshaking);
    // 电脑没回（丢帧、电脑卡住）：不停在「正在建立加密连接」，断开按退避重连
    _unguard();
    final ws = _ws;
    _guard = Timer(timings.handshakeTimeout, () {
      _guard = null;
      if (identical(_ws, ws) && state != LinkState.ready) _lost(ws, 0);
    });
  }

  void _onFrame(Uint8List frame) {
    final ({FrameType type, Uint8List body}) f;
    try {
      f = decodeFrame(frame);
    } on LinkException {
      return;
    }
    switch (f.type) {
      case FrameType.pairResult:
        _onPairResult(f.body);
      case FrameType.handshake2:
        final initiator = _initiator;
        if (initiator == null) return;
        try {
          _finish(initiator.readMessage2(f.body).result);
        } catch (_) {
          _lost(_ws, 0);
        }
      case FrameType.data:
        _channel?.receive(f.body);
      case FrameType.handshake1 || FrameType.pair:
        break;
    }
  }

  /// 结果帧不加密、经云端：已配好的电脑不因它被删，只更新提示、决定何时重试；真被移除时云端以 4001 关连接
  void _onPairResult(Uint8List body) {
    final Object? raw;
    try {
      raw = decodeJson(body);
    } on LinkException {
      return;
    }
    if (raw is! Map) return;
    final status = raw['status'];
    if (pairing.status == PairingStatus.pending) {
      // 还在等确认：rejected 就是电脑上点了「拒绝」
      if (status == 'pending') {
        _set(LinkState.waitingConfirm);
      } else if (status == 'rejected') {
        _removed();
      } else if (status == 'accepted') {
        pairing = pairing.copyWith(
          status: PairingStatus.paired,
          clearRequest: true,
        );
        _hooks.onPairing(pairing);
        _handshake();
      }
    } else if (status == 'unknown') {
      _reset();
      _set(LinkState.unrecognized);
      _retryHandshake(timings.retryLater);
    } else if (status == 'handshake_failed' &&
        raw['v'] != null &&
        raw['v'] != linkVersion) {
      _reset();
      _unguard();
      _set(LinkState.incompatible);
    } else if (status == 'unavailable' || status == 'handshake_failed') {
      _retryHandshake(timings.retrySoon);
    }
  }

  void _finish(HandshakeResult keys) {
    _initiator = null;
    final ws = _ws;
    late final SecureChannel channel;
    final rpc = RpcCore((m) {
      channel.send(m).catchError((Object _) {});
    });
    channel = SecureChannel(
      keys,
      output: (frame) {
        if (identical(_ws, ws)) ws?.send(frame);
      },
      onMessage: rpc.receive,
      // 解不开：这条加密会话作废，重新握手
      onError: (_) {
        if (identical(_rpc, rpc)) _handshake();
      },
      codec: deflateRawCodec,
    );
    rpc.onEvent = (name, data) {
      for (final event in unbatch(data)) {
        _hooks.onEvent(name, event);
      }
    };
    _rpc = rpc;
    _channel = channel;
    rpc
        .call('hello', [_hello], timings.helloTimeout)
        .then(
          (raw) {
            if (!identical(_rpc, rpc)) return;
            _unguard();
            final h = Hello.parse(raw);
            if (h.version != linkVersion) {
              _reset();
              _set(LinkState.incompatible);
              return;
            }
            hello = h;
            _set(LinkState.ready);
          },
          // 这条加密会话已经换掉了（重新握手时 reset 关掉旧的 rpc 也会走到这里）：别把正在新握手的连接关掉
          onError: (Object _) {
            if (identical(_rpc, rpc)) _lost(_ws, 0);
          },
        );
  }
}
