// 每台电脑的会话列表和项目（照网页版 data/desktop.ts）：全 App 一份，抽屉、概览、会话页共用。
// 连上 / 重连时取一次，之后跟着电脑推来的事件更新。
// 最近一次的列表存在本机（list_cache.dart，A3）：打开时先显示（cached 为 true），连上取到新的再换。
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import 'list_cache.dart';
import 'tasks.dart';

class DesktopData {
  const DesktopData({
    this.sessions = const [],
    this.projects = const [],
    this.loaded = false,
    this.cached = false,
  });
  final List<SessionSummary> sessions;
  final List<Project> projects;

  /// 取到过列表了（显示的是本机缓存时也是 true）
  final bool loaded;

  /// 显示的是上次存在本机的列表，这次还没从电脑取到新的
  final bool cached;
}

class DesktopLists extends ChangeNotifier {
  DesktopLists(this._connections, {this._cache}) {
    _connections.addListener(_check);
    _events = _connections.events.listen(_onEvent);
    _check();
  }

  final Connections _connections;
  final ListCache? _cache;

  /// 已经读过缓存的电脑（每台只读一次）
  final _cacheRead = <String>{};
  late final StreamSubscription<DesktopEvent> _events;
  final _data = <String, DesktopData>{};
  final _states = <String, LinkState?>{};

  /// 每台电脑收到过几次推送：取列表期间推来过，回来的结果不比推送新，不拿它覆盖
  final _pushes = <String, ({int sessions, int projects})>{};

  DesktopData get(String deviceId) => _data[deviceId] ?? const DesktopData();

  void _set(
    String deviceId, {
    List<SessionSummary>? sessions,
    List<Project>? projects,
    bool? loaded,
    bool cached = false,
  }) {
    // 请求回来时这台电脑已经被忘掉了：丢掉
    if (!_connections.pairings.any((p) => p.deviceId == deviceId)) return;
    final old = get(deviceId);
    final next = DesktopData(
      sessions: sessions ?? old.sessions,
      projects: projects ?? old.projects,
      loaded: loaded ?? old.loaded,
      cached: cached,
    );
    _data[deviceId] = next;
    // 电脑给的才存（缓存读出来的不再写回）
    if (!cached && next.loaded) {
      _cache?.save(deviceId, (
        sessions: next.sessions,
        projects: next.projects,
      ));
    }
    notifyListeners();
  }

  ({int sessions, int projects}) _count(String id) =>
      _pushes[id] ?? (sessions: 0, projects: 0);

  void _onEvent(DesktopEvent e) {
    if (e.channel != 'engine:event') return;
    final data = e.data;
    if (data is! Map) return;
    final c = _count(e.deviceId);
    if (data['kind'] == 'sessions') {
      _pushes[e.deviceId] = (sessions: c.sessions + 1, projects: c.projects);
      _set(e.deviceId, sessions: summariesOf(data['sessions']));
    } else if (data['kind'] == 'projects') {
      _pushes[e.deviceId] = (sessions: c.sessions, projects: c.projects + 1);
      _set(e.deviceId, projects: projectsOf(data['projects']));
    }
  }

  /// 重新取（下拉刷新）
  Future<void> refresh(String deviceId) async {
    final link = _connections.link(deviceId);
    if (link == null || link.state != LinkState.ready) return;
    final before = _count(deviceId);
    final results = await Future.wait([
      link.call('engine:sessions'),
      link.call('engine:projects'),
    ]);
    final now = _count(deviceId);
    _set(
      deviceId,
      sessions: now.sessions == before.sessions
          ? summariesOf(results[0])
          : null,
      projects: now.projects == before.projects ? projectsOf(results[1]) : null,
      loaded: true,
    );
  }

  /// 变成「已连接」时取一次（断开期间漏掉的推送靠这一次补上）；忘掉的电脑清掉
  void _check() {
    final keep = {for (final p in _connections.pairings) p.deviceId};
    _data.removeWhere((id, _) => !keep.contains(id));
    _states.removeWhere((id, _) => !keep.contains(id));
    _pushes.removeWhere((id, _) => !keep.contains(id));
    if (_connections.loaded) {
      for (final id in [..._cacheRead]) {
        if (!keep.contains(id)) {
          _cacheRead.remove(id);
          _cache?.drop(id);
        }
      }
    }
    for (final id in keep) {
      if (_cacheRead.add(id)) _loadCache(id);
      final state = _connections.state(id);
      final before = _states[id];
      _states[id] = state;
      if (state == LinkState.ready && before != LinkState.ready) {
        refresh(id).catchError((Object _) {});
      }
    }
  }

  /// 打开时先显示上次的列表；电脑的已经到了就不用了
  Future<void> _loadCache(String id) async {
    final lists = await _cache?.load(id);
    if (lists == null || get(id).loaded) return;
    _set(
      id,
      sessions: lists.sessions,
      projects: lists.projects,
      loaded: true,
      cached: true,
    );
  }

  /// 切到后台前把等着的写掉
  Future<void> flushCache() async => _cache?.flush();

  @override
  void dispose() {
    _connections.removeListener(_check);
    _events.cancel();
    super.dispose();
  }
}
