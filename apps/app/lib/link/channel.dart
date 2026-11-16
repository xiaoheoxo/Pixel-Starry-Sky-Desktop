// 握手之后的加密通道（照 packages/link/src/channel.ts）：JSON →（超过 1 KB 先压缩）→ 加密 → 数据帧。
// 压缩由平台提供（电脑用 zlib，网页版用 CompressionStream，App 用 dart:io 的 zlib），接口允许异步，
// 所以发送和接收各排一条队，保证顺序和计数一致。任何一帧解不开，通道就作废，调用方断开后重新握手。
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'bytes.dart';
import 'frame.dart';
import 'noise.dart';

abstract interface class Codec {
  /// deflate-raw 压缩
  FutureOr<Uint8List> deflate(Uint8List bytes);

  /// deflate-raw 解压；解出来超过 [maxBytes] 就抛错（防压缩炸弹）
  FutureOr<Uint8List> inflate(Uint8List bytes, int maxBytes);
}

/// App 用的压缩：dart:io 的 zlib（deflate-raw），和电脑端 zlib、网页版 CompressionStream 互通。
/// 超过上限报 LINK_FRAME_TOO_LARGE（同网页版 connection/codec.ts），数据坏了报 LINK_BAD_FRAME。
/// 注意：截断的压缩数据这里不报错、返回已解出的部分（dart:io 不告诉流是否完整），之后解 JSON 通常会失败；
/// 电脑端和网页版会直接报错。数据都经过认证加密，只有对方出了 bug 才会遇到。
class DeflateRawCodec implements Codec {
  const DeflateRawCodec();

  static final _zlib = ZLibCodec(raw: true);

  @override
  Uint8List deflate(Uint8List bytes) =>
      Uint8List.fromList(_zlib.encoder.convert(bytes));

  @override
  Uint8List inflate(Uint8List bytes, int maxBytes) {
    final out = _LimitedSink(maxBytes);
    try {
      _zlib.decoder.startChunkedConversion(out)
        ..add(bytes)
        ..close();
    } on LinkException {
      rethrow;
    } catch (_) {
      throw const LinkException('LINK_BAD_FRAME');
    }
    return out.bytes.takeBytes();
  }
}

/// 边解边数，超过上限立刻停（不先解出整块再看大小）
class _LimitedSink implements Sink<List<int>> {
  _LimitedSink(this.max);

  final int max;
  final bytes = BytesBuilder(copy: false);

  @override
  void add(List<int> chunk) {
    if (bytes.length + chunk.length > max) {
      throw const LinkException('LINK_FRAME_TOO_LARGE');
    }
    bytes.add(chunk);
  }

  @override
  void close() {}
}

const deflateRawCodec = DeflateRawCodec();

const _raw = 0;
const _deflate = 1;

/// 小于这个大小的不压缩（M0：压缩对小帧没有好处）
const _compressFrom = 1024;

/// 解压后的上限
const _inflatedLimit = 16 * 1024 * 1024;

bool _tooLarge(Object e) =>
    e is LinkException && e.message == 'LINK_FRAME_TOO_LARGE';

class SecureChannel {
  /// [output] 发出一个完整的帧；[onMessage] 收到一条消息（按到达顺序）；
  /// [onError] 通道作废（解不开、解压失败、发不出去），只调用一次
  SecureChannel(
    this._keys, {
    required this._output,
    required this._onMessage,
    required this._onError,
    this._codec,
  });

  final HandshakeResult _keys;
  final void Function(Uint8List frame) _output;
  final void Function(Object? value) _onMessage;
  final void Function(Object error) _onError;
  final Codec? _codec;
  Future<void> _sending = Future.value();
  Future<void> _receiving = Future.value();
  Object? _broken;

  bool get closed => _broken != null;

  /// 太大的一条（LINK_FRAME_TOO_LARGE）只让这一次调用失败；调用方要处理返回的错误
  Future<void> send(Object? value) {
    final task = _sending.then((_) async {
      final broken = _broken;
      if (broken != null) throw broken;
      final json = encodeJson(value);
      final codec = _codec;
      final body = codec != null && json.length >= _compressFrom
          ? concat([
              const [_deflate],
              await codec.deflate(json),
            ])
          : concat([
              const [_raw],
              json,
            ]);
      if (body.length > maxPayload) {
        throw const LinkException('LINK_FRAME_TOO_LARGE');
      }
      _output(encodeFrame(FrameType.data, _keys.send.seal(body)));
    });
    // 太大的一条只让这一次调用失败；加密或发送出错则整个通道作废
    _sending = task.then(
      (_) {},
      onError: (Object e) {
        if (!_tooLarge(e)) fail(e);
      },
    );
    return task;
  }

  /// 收到数据帧的内容（不含帧类型字节）
  void receive(Uint8List body) {
    if (_broken != null) return;
    final Uint8List plain;
    try {
      // 解密必须按到达顺序同步做：计数和对方的发送顺序一一对应
      plain = _keys.receive.open(body);
    } catch (e) {
      fail(e);
      return;
    }
    _receiving = _receiving.then((_) async {
      if (_broken != null) return;
      try {
        // 空的明文没有标志字节：TS 里 plain[0] 是 undefined，同样算坏帧
        final flag = plain.isEmpty ? -1 : plain[0];
        final codec = _codec;
        if (flag == _deflate && codec == null) {
          throw const LinkException('LINK_BAD_FRAME');
        }
        if (flag != _raw && flag != _deflate) {
          throw const LinkException('LINK_BAD_FRAME');
        }
        final data = Uint8List.sublistView(plain, 1);
        final json = flag == _deflate
            ? await codec!.inflate(data, _inflatedLimit)
            : data;
        _onMessage(decodeJson(json));
      } catch (e) {
        fail(e);
      }
    });
  }

  void fail(Object error) {
    if (_broken != null) return;
    _broken = error;
    _onError(error);
  }
}
