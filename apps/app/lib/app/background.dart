// 在后台时（docs/mobile-app.md §8.2）：安卓起前台服务保持连接；连接还在时自己比较会话列表，有任务等你处理 / 完成 / 出错
// 就弹本机提醒（规则同电脑推送，每台电脑攒 2 秒合成一条）。回到前台时停掉服务、攒着的不提醒了。
// iOS 切到后台后很快被系统挂起，这里基本收不到；锁屏提醒要靠 A3b 的系统推送。
import 'dart:async';

import '../connection/connections.dart';
import '../data/desktop_lists.dart';
import '../data/notify.dart';
import '../data/tasks.dart';
import '../i18n/i18n.dart';
import '../platform/notifier.dart';
import 'settings.dart';

class BackgroundWatcher {
  BackgroundWatcher({
    required this.notifier,
    required this.settings,
    this.delay = const Duration(seconds: 2),
  });

  final Notifier notifier;
  final AppSettings settings;
  final Duration delay;

  bool _foreground = true;
  final _prev = <String, List<SessionSummary>>{};
  final _pending = <String, ({NotifySessions sessions, Timer timer})>{};

  bool get foreground => _foreground;

  /// 电脑给的新列表（缓存读出来的不算：fromDesktop 为 false 时只记下，不比较）
  void update(
    String device,
    List<SessionSummary> sessions, {
    bool fromDesktop = true,
  }) {
    final prev = _prev[device];
    _prev[device] = sessions;
    if (!fromDesktop || _foreground) return;
    final changes = notifyChanges(prev, sessions);
    if (notifyPayload(changes) == null) return;
    final pending = _pending[device];
    if (pending != null) {
      mergeNotify(pending.sessions, changes);
      return;
    }
    _pending[device] = (
      sessions: changes,
      timer: Timer(delay, () {
        final p = _pending.remove(device);
        final payload = p == null ? null : notifyPayload(p.sessions);
        if (payload != null && !_foreground) {
          notifier.show(payload, device).catchError((Object _) {});
        }
      }),
    );
  }

  /// 忘掉的电脑
  void forget(String device) {
    _prev.remove(device);
    _pending.remove(device)?.timer.cancel();
  }

  /// 前后台切换；keepAliveText 是前台服务通知上的字（null：不需要保持连接）
  void setForeground(bool foreground, {String? keepAliveText}) {
    if (_foreground == foreground) return;
    _foreground = foreground;
    if (foreground) {
      for (final p in _pending.values) {
        p.timer.cancel();
      }
      _pending.clear();
      notifier.keepAlive(null).catchError((Object _) {});
    } else if (settings.keepAlive && keepAliveText != null) {
      notifier.keepAlive(keepAliveText).catchError((Object _) {});
    }
  }

  /// 接上 App 的连接和列表
  void attach(Connections connections, DesktopLists lists) {
    void sync() {
      final keep = {for (final p in connections.pairings) p.deviceId};
      for (final id in [..._prev.keys]) {
        if (!keep.contains(id)) forget(id);
      }
      for (final id in keep) {
        final data = lists.get(id);
        if (!data.loaded) continue;
        if (identical(_seen[id], data)) continue;
        _seen[id] = data;
        update(id, data.sessions, fromDesktop: !data.cached);
      }
    }

    lists.addListener(sync);
    sync();
  }

  final _seen = <String, DesktopData>{};
}

/// 前台服务通知上的字：一台电脑写名字，几台写台数
String keepAliveText(Connections connections) {
  final list = connections.pairings;
  if (list.isEmpty) return '';
  return list.length == 1
      ? L(
          '已连上「${list.first.desktopName}」，有任务等你处理时会提醒',
          'Connected to “${list.first.desktopName}”. You\'ll be alerted when a task needs you.',
        )
      : L(
          '保持和 ${list.length} 台电脑的连接',
          'Staying connected to ${list.length} computers',
        );
}
