// 桌面小部件上的字（第三批 D3，docs/mobile-app.md §15.9）：所有配过的电脑里等你处理的会话，
// 「等你处理 2 件」+ 第一件的标题；没有时「都处理完了」+ 最后同步时间。数据只在 App 活着时更新，
// 被系统杀了以后显示的是最后同步的时间，不假装是最新的。
import '../i18n/i18n.dart';
import 'tasks.dart';

class WidgetState {
  const WidgetState({
    required this.title,
    required this.body,
    required this.waiting,
  });
  final String title;
  final String body;
  final bool waiting;

  @override
  bool operator ==(Object other) =>
      other is WidgetState &&
      other.title == title &&
      other.body == body &&
      other.waiting == waiting;

  @override
  int get hashCode => Object.hash(title, body, waiting);
}

String _clock(DateTime t) =>
    '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

/// lists：每台电脑的会话（只算从电脑拿到的，缓存读的不算）；syncedAt：最后一次从电脑拿到列表的时间
WidgetState widgetState(
  List<List<SessionSummary>> lists, {
  required DateTime syncedAt,
}) {
  final waiting = [
    for (final list in lists)
      for (final s in list)
        if (s.state == 'waiting' && !s.archived) s,
  ]..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  final synced = L(
    '最后同步 ${_clock(syncedAt)}',
    'Last synced ${_clock(syncedAt)}',
  );
  if (waiting.isEmpty) {
    return WidgetState(
      title: L('都处理完了', 'All caught up'),
      body: synced,
      waiting: false,
    );
  }
  final n = waiting.length;
  return WidgetState(
    title: L('等你处理 $n 件', n == 1 ? '1 task needs you' : '$n tasks need you'),
    body: '${taskTitle(waiting.first)} · ${_clock(syncedAt)}',
    waiting: true,
  );
}
