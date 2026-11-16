// 按消息收发的对称 RPC（照 packages/link/src/rpc.ts）：调用、回复、事件三种消息。不关心消息怎么传，
// 手机用加密通道（channel.dart）。消息是 JSON 对象（Map），键的顺序和 TS 发出的一致。
import 'dart:async';
import 'dart:developer' as developer;

import 'bytes.dart';

typedef RpcHandler = FutureOr<Object?> Function(String method, List args);

/// 调用 {id, method, args}、回复 {id, result}、错误 {id, error}、事件 {event, data}
typedef RpcMessage = Map<String, Object?>;

/// output 抛这个（LinkException 的 message）表示只是这一条太大（传输层的上限），连接本身还能用
const rpcSizeLimit = 'RPC_SIZE_LIMIT';

bool _tooBig(Object e) => e is LinkException && e.message == rpcSizeLimit;

/// JS 的安全整数上限（Number.MAX_SAFE_INTEGER）：TS 只认这个范围内的整数 id
const _maxSafeInteger = 9007199254740991;

/// 同 TS 的 Number.isSafeInteger；JSON 里 1.0 这种整数值的小数也算
int? _safeId(Object? id) {
  if (id is int) return id.abs() <= _maxSafeInteger ? id : null;
  if (id is double && id.isFinite && id == id.truncateToDouble()) {
    return id.abs() <= _maxSafeInteger ? id.toInt() : null;
  }
  return null;
}

/// JS 的真假判断：TS 用 `if (message.error)` 决定是不是错误回复
bool _truthy(Object? v) => switch (v) {
  null => false,
  bool b => b,
  num n => n != 0 && !n.isNaN,
  String s => s.isNotEmpty,
  _ => true,
};

/// JS 的 String(v)：错误回复里的 error 不是字符串时转成文字的方式
String _jsString(Object? v) => switch (v) {
  null => 'null',
  String s => s,
  double d when d.isFinite && d == d.truncateToDouble() && d.abs() < 1e21 =>
    d.toInt().toString(),
  List l => l.map((e) => e == null ? '' : _jsString(e)).join(','),
  Map _ => '[object Object]',
  _ => v.toString(),
};

class _Pending {
  _Pending(this.completer, this.timer);

  final Completer<Object?> completer;
  final Timer timer;
}

class RpcCore {
  /// [output] 发出一条消息；抛错表示发不出去（抛 LinkException(rpcSizeLimit)：这一条太大；别的：连接断了）。
  /// [handler] 处理对方的调用，抛 LinkException 时把 message 作为错误回给对方，别的错误回 RPC_FAILED。
  /// [closedMessage] 连接已关闭时调用报的错
  RpcCore(
    this._output, {
    RpcHandler? handler,
    this._closedMessage = 'LINK_CLOSED',
  }) : _handler = handler ?? _unknownMethod;

  static Never _unknownMethod(String method, List args) =>
      throw const LinkException('Unknown RPC method');

  final void Function(RpcMessage message) _output;
  final RpcHandler _handler;
  final String _closedMessage;
  int _sequence = 0;
  final _pending = <int, _Pending>{};
  bool _closed = false;

  void Function(String channel, Object? data) onEvent = (_, _) {};
  void Function(Object error) onClose = (_) {};

  bool get isClosed => _closed;

  /// 超时报 `RPC_TIMEOUT: <method>`；连接关闭时挂着的调用都以关闭原因失败
  Future<Object?> call(
    String method, [
    List<Object?> args = const [],
    Duration timeout = const Duration(seconds: 120),
  ]) {
    if (_closed) return Future.error(LinkException(_closedMessage));
    final id = ++_sequence;
    final completer = Completer<Object?>();
    final timer = Timer(timeout, () {
      _pending.remove(id);
      if (!completer.isCompleted) {
        completer.completeError(LinkException('RPC_TIMEOUT: $method'));
      }
    });
    _pending[id] = _Pending(completer, timer);
    try {
      _output({'id': id, 'method': method, 'args': args});
    } catch (e) {
      timer.cancel();
      _pending.remove(id);
      // output 里可能已经 close 过、把这个调用拒绝了
      if (!completer.isCompleted) completer.completeError(e);
    }
    return completer.future;
  }

  void event(String channel, Object? data) {
    if (_closed) return;
    try {
      _output({'event': channel, 'data': data});
    } catch (e) {
      // 太大的事件丢掉、记一笔，连接照常；别的写错误关闭连接
      if (_tooBig(e)) {
        developer.log('event dropped: $rpcSizeLimit $channel', name: 'rpc');
      } else {
        close(e);
      }
    }
  }

  /// 回复太大：改回一个错误，调用方看到 RPC_SIZE_LIMIT，连接照常；别的写错误往外抛（关闭连接）
  void _reply(RpcMessage message) {
    if (_closed) return;
    try {
      _output(message);
    } catch (e) {
      if (!_tooBig(e)) rethrow;
      _output({'id': message['id'], 'error': rpcSizeLimit});
    }
  }

  /// 收到一条已经解析好的消息；格式不对就关闭（对方不可信或协议不一致）
  void receive(Object? raw) {
    if (_closed) return;
    // TS 里 null、数组、字符串、数字取不到这些字段，都落到「Invalid RPC id」
    final message = raw is Map ? raw : const <String, Object?>{};
    try {
      final event = message['event'];
      if (event is String) {
        onEvent(event, message['data']);
        return;
      }
      final id = _safeId(message['id']);
      if (id == null) throw const LinkException('Invalid RPC id');
      final method = message['method'];
      if (method is String) {
        final args = message['args'];
        if (args is! List) throw const LinkException('Invalid RPC arguments');
        Future<Object?>.microtask(() => _handler(method, args))
            .then(
              (result) => _reply({'id': id, 'result': result}),
              onError: (Object e) => _reply({
                'id': id,
                'error': e is LinkException ? e.message : 'RPC_FAILED',
              }),
            )
            .catchError((Object e) => close(e));
        return;
      }
      final pending = _pending.remove(id);
      if (pending == null) return;
      pending.timer.cancel();
      final error = message['error'];
      if (_truthy(error)) {
        pending.completer.completeError(LinkException(_jsString(error)));
      } else {
        pending.completer.complete(message['result']);
      }
    } catch (e) {
      close(e);
    }
  }

  void close([Object? error]) {
    if (_closed) return;
    _closed = true;
    final reason = error ?? LinkException(_closedMessage);
    for (final p in _pending.values) {
      p.timer.cancel();
      if (!p.completer.isCompleted) p.completer.completeError(reason);
    }
    _pending.clear();
    onClose(reason);
  }
}
