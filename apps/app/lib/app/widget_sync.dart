// 桌面小部件跟着会话列表走（第三批 D3，docs/mobile-app.md §15.9）：从电脑拿到新列表就重算，字没变不写；
// 攒 2 秒写一次（列表推得勤）。缓存读出来的列表不算同步。
import 'dart:async';

import '../connection/connections.dart';
import '../data/desktop_lists.dart';
import '../data/tasks.dart';
import '../data/widget_state.dart';
import '../platform/home_widget.dart';

class WidgetSync {
  WidgetSync(
    this.widget, {
    this.delay = const Duration(seconds: 2),
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  final HomeScreenWidget widget;
  final Duration delay;
  final DateTime Function() _now;

  WidgetState? _shown;
  DateTime? _syncedAt;
  Timer? _timer;
  void Function()? _detach;

  void attach(Connections connections, DesktopLists lists) {
    void changed() {
      final fresh = [
        for (final p in connections.pairings)
          if (lists.get(p.deviceId) case final d when d.loaded && !d.cached)
            d.sessions,
      ];
      if (fresh.isEmpty) return;
      _syncedAt = _now();
      _timer ??= Timer(delay, () {
        _timer = null;
        _write([
          for (final p in connections.pairings)
            if (lists.get(p.deviceId) case final d when d.loaded) d.sessions,
        ]);
      });
    }

    lists.addListener(changed);
    _detach = () => lists.removeListener(changed);
    changed();
  }

  void _write(List<List<SessionSummary>> lists) {
    final synced = _syncedAt;
    if (synced == null) return;
    final state = widgetState(lists, syncedAt: synced);
    if (state == _shown) return;
    _shown = state;
    widget.show(state).catchError((Object _) {});
  }

  void dispose() {
    _timer?.cancel();
    _detach?.call();
  }
}
