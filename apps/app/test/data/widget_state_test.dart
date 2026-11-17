// D3：桌面小部件上的字（docs/mobile-app.md §15.9）：几台电脑合起来数等你处理的，第一件是最新的那件；
// 没有时写都处理完了和最后同步时间；归档的不算。
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/data/tasks.dart';
import 'package:pixelsky_app/data/widget_state.dart';
import 'package:pixelsky_app/i18n/i18n.dart';

SessionSummary _s(String id, String state, num at, {bool archived = false}) =>
    SessionSummary({
      'record': {
        'id': id,
        'projectId': 'p',
        'title': '任务 $id',
        'updatedAt': at,
        if (archived) 'archivedAt': 1,
      },
      'state': state,
    });

void main() {
  setUp(() => language.value = AppLanguage.zh);
  final at = DateTime(2026, 11, 18, 9, 5);

  test('几台电脑合起来数，第一件是最新的', () {
    final s = widgetState([
      [_s('a', 'waiting', 1), _s('b', 'idle', 9)],
      [_s('c', 'waiting', 5), _s('d', 'waiting', 9, archived: true)],
    ], syncedAt: at);
    expect(s.title, '等你处理 2 件');
    expect(s.body, '任务 c · 09:05');
    expect(s.waiting, isTrue);
  });

  test('没有在等的：都处理完了 + 最后同步时间', () {
    final s = widgetState([
      [_s('a', 'idle', 1)],
    ], syncedAt: at);
    expect(s.title, '都处理完了');
    expect(s.body, '最后同步 09:05');
    expect(s.waiting, isFalse);
    expect(s, widgetState(const [], syncedAt: at), reason: '字一样就算同一个，不重写');
  });
}
