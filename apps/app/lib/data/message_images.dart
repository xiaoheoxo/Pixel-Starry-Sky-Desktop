// 消息里的图片（用户发的图、工具结果里的图）：会话内容和推送里电脑把图片数据去掉了（只留名字、大小、宽高），
// 看到时经网关的 image(sessionId, itemId, 第几张) 取一张（太大电脑先缩小）。取过的留在内存里，最多 kept 张。
import 'dart:convert';
import 'dart:typed_data';

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../i18n/i18n.dart';
import '../protocol/json.dart';
import 'actions.dart';

class MessageImages {
  MessageImages(this._connections, this.deviceId, this.sessionId);

  final Connections _connections;
  final String deviceId;
  final String sessionId;

  /// 最多留几张（每张最多约 1 MB）
  static const kept = 24;
  final _cache = <String, Future<Uint8List>>{};

  Future<Uint8List> load(String itemId, int index) =>
      _fetch('$itemId/$index', 'image', [sessionId, itemId, index]);

  /// 回复里 Markdown 图片指向的本地文件（§15.17）：地址原样交给电脑，按这个会话的工作目录读，项目外的不给
  Future<Uint8List> file(String src) =>
      _fetch('file:$src', 'fileImage', [sessionId, src]);

  Future<Uint8List> _fetch(String key, String method, List<Object?> args) {
    final hit = _cache.remove(key);
    if (hit != null) return _cache[key] = hit; // 挪到最后（最近用过）
    final link = _connections.link(deviceId);
    final future =
        (link == null
                ? Future<Object?>.error(const LinkNotReady())
                : link.call(method, args))
            .then((r) {
              final data = str(obj(r)['dataBase64']);
              if (data == null || data.isEmpty) {
                throw Exception('MOBILE_NOT_FOUND');
              }
              return base64Decode(data);
            });
    _cache[key] = future;
    // 失败的不留（重连后再看能重新取）
    future.catchError((Object _) {
      if (identical(_cache[key], future)) _cache.remove(key);
      return Uint8List(0);
    });
    while (_cache.length > kept) {
      _cache.remove(_cache.keys.first);
    }
    return future;
  }
}

/// 取图失败的人话
String imageError(Object e) {
  final code = '$e'.replaceFirst(RegExp(r'^Exception: '), '');
  return switch (code) {
    'MOBILE_TOO_LARGE' => L(
      '图片太大，请到电脑上看',
      'Too large — view it on the computer',
    ),
    'MOBILE_NOT_FOUND' => L('图片已经不在了', 'This image is no longer available'),
    _ => actionError(e),
  };
}
