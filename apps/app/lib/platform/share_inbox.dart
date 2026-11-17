// 别的 App 分享进来（receive_sharing_intent，只接了安卓的分享声明）：冷启动时带的一份和开着时收到的。
// 平台相关的都在这里；界面只用 ShareInbox 接口（测试里不给）。
import 'dart:async';
import 'dart:io';

import 'package:receive_sharing_intent/receive_sharing_intent.dart';

import '../data/share.dart';

abstract interface class ShareInbox {
  /// 冷启动时是不是从分享打开的
  Future<SharedContent?> initial();

  /// 开着时又分享进来的
  Stream<SharedContent> get received;
}

class NoShareInbox implements ShareInbox {
  const NoShareInbox();
  @override
  Future<SharedContent?> initial() async => null;
  @override
  Stream<SharedContent> get received => const Stream.empty();
}

class PluginShareInbox implements ShareInbox {
  ReceiveSharingIntent get _plugin => ReceiveSharingIntent.instance;

  static SharedContent? _convert(List<SharedMediaFile> files) {
    final c = sharedContent([
      for (final f in files) (type: f.type.value, path: f.path),
    ]);
    return c.isEmpty ? null : c;
  }

  @override
  Future<SharedContent?> initial() async {
    if (!Platform.isAndroid) return null;
    final files = await _plugin.getInitialMedia();
    // 取过就清掉，免得下次冷启动又当成分享进来的
    unawaited(_plugin.reset());
    return _convert(files);
  }

  @override
  Stream<SharedContent> get received => Platform.isAndroid
      ? _plugin.getMediaStream().map(_convert).where((c) => c != null).cast()
      : const Stream.empty();
}
