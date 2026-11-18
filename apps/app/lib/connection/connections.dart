// 连接层的入口（同网页版 connection/index.ts 的 Connections）：所有配对过的电脑和它们的连接。
// 界面只通过这里接触 lib/link；变化时 notifyListeners。
import 'dart:async';

import 'package:flutter/foundation.dart';

import 'desktop_link.dart';
import 'pairing.dart';
import 'route.dart';
import 'socket.dart';
import 'storage.dart';

/// 电脑推来的一条事件
typedef DesktopEvent = ({String deviceId, String channel, Object? data});

class Connections extends ChangeNotifier {
  Connections({
    required this._store,
    required this._connect,
    this._timings = const LinkTimings(),
    this._route,
  }) {
    // 线路后台试探通了（docs/mobile-app.md §20）：每台电脑空闲时重连到新线路
    _rerouted = _route?.improved.listen((_) {
      for (final l in _links.values) {
        l.rerouteWhenIdle();
      }
    });
  }

  final RouteState? _route;
  StreamSubscription<RouteTier>? _rerouted;

  final PairingStore _store;
  final SocketFactory _connect;
  final LinkTimings _timings;
  List<Pairing> _pairings = const [];
  String? _active;
  final _links = <String, DesktopLink>{};
  final _events = StreamController<DesktopEvent>.broadcast();
  Timer? _heartbeat;
  bool _foreground = true;
  bool _loaded = false;

  bool get loaded => _loaded;
  Stream<DesktopEvent> get events => _events.stream;
  List<Pairing> get pairings => _pairings;

  /// 读出存着的配对，连上每一台
  Future<void> load() async {
    _pairings = await _store.load();
    _active = await _store.activeDevice();
    for (final p in _pairings) {
      _linkOf(p);
    }
    // 在前台时每 20 秒说一声：突然断网时电脑据此知道该推送了（gateway.ts 的 SILENT_AFTER）
    _heartbeat = Timer.periodic(const Duration(seconds: 20), (_) {
      if (!_foreground) return;
      for (final l in _links.values) {
        l.away(false);
      }
    });
    _loaded = true;
    notifyListeners();
  }

  DesktopLink? link(String deviceId) => _links[deviceId];
  LinkState? state(String deviceId) => _links[deviceId]?.state;

  /// 当前看的电脑：上次选的，或者第一台
  Pairing? get active {
    for (final p in _pairings) {
      if (p.deviceId == _active) return p;
    }
    return _pairings.isEmpty ? null : _pairings.first;
  }

  DesktopLink _linkOf(Pairing p) {
    final existing = _links[p.deviceId];
    if (existing != null) return existing;
    final link = DesktopLink(
      p,
      LinkHooks(
        onState: (_) => notifyListeners(),
        onEvent: (channel, data) =>
            _events.add((deviceId: p.deviceId, channel: channel, data: data)),
        onPairing: (next) {
          _pairings = [
            for (final x in _pairings) x.deviceId == next.deviceId ? next : x,
          ];
          unawaited(_store.save(_pairings));
          notifyListeners();
        },
      ),
      connect: _connect,
      timings: _timings,
    );
    _links[p.deviceId] = link;
    link.start();
    return link;
  }

  /// 配对成功（等电脑上确认）：同一台电脑重新配对时旧记录换成新的，不留两条
  Future<void> add(Pairing p) async {
    for (final old in _pairings.where(
      (x) => x.desktopId == p.desktopId && x.deviceId != p.deviceId,
    )) {
      _links.remove(old.deviceId)?.stop();
    }
    _pairings = [..._pairings.where((x) => x.desktopId != p.desktopId), p];
    _active = p.deviceId;
    await _store.save(_pairings);
    await _store.setActiveDevice(p.deviceId);
    _linkOf(p);
    notifyListeners();
  }

  /// 在手机上忘掉这台电脑（电脑那边的记录要在电脑上移除）
  Future<void> forget(String deviceId) async {
    _links.remove(deviceId)?.stop();
    _pairings = [
      for (final p in _pairings)
        if (p.deviceId != deviceId) p,
    ];
    await _store.save(_pairings);
    if (_active == deviceId) {
      _active = _pairings.isEmpty ? null : _pairings.first.deviceId;
      await _store.setActiveDevice(_active);
    }
    notifyListeners();
  }

  Future<void> select(String deviceId) async {
    _active = deviceId;
    await _store.setActiveDevice(deviceId);
    notifyListeners();
  }

  /// 断线横幅上点「立即重试」：不等退避，马上重连
  void retryNow(String deviceId) => _links[deviceId]?.wake();

  /// 被别的设备顶掉后点「重新连接」
  void reconnect(String deviceId) => _links[deviceId]?.reconnect();

  /// App 切到后台 / 回到前台（AppLifecycleState）：告诉电脑；回到前台马上重连或探一下
  void setForeground(bool foreground) {
    if (_foreground == foreground) return;
    _foreground = foreground;
    for (final l in _links.values) {
      if (foreground) l.wake();
      l.away(!foreground);
    }
    // 回到前台时也试一次靠前的线路
    if (foreground) unawaited(_route?.probeNow());
  }

  @override
  void dispose() {
    _heartbeat?.cancel();
    _rerouted?.cancel();
    for (final l in _links.values) {
      l.stop();
    }
    _events.close();
    super.dispose();
  }
}
