// 后台子智能体还在跑（docs/mobile-app.md §17）：列表状态、完成提醒等它们跑完、会话页那一条列出的是谁
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/data/background_agents.dart';
import 'package:pixelsky_app/data/notify.dart';
import 'package:pixelsky_app/data/tasks.dart';
import 'package:pixelsky_app/i18n/i18n.dart';

SessionSummary s(String state, {int background = 0}) => SessionSummary({
  'record': {'id': 'a', 'projectId': 'p', 'lastOutcome': 'completed'},
  'state': state,
  if (background > 0) 'background': background,
});

void main() {
  setUp(() => language.value = AppLanguage.zh);

  test('一轮说完但后台还在跑：列表算在忙，写几个在跑', () {
    final st = sessionStatus(s('idle', background: 2))!;
    expect(st.text, '后台 2 个子智能体在跑');
    expect(st.pulse, isTrue);
    expect(s('idle', background: 2).busy, isTrue);
    expect(sessionStatus(s('idle')), isNull);
  });

  test('完成提醒等后台子智能体都跑完', () {
    List<String> done(SessionSummary a, SessionSummary b) =>
        notifyChanges([a], [b])[NotifyKind.completed]!.toList();
    expect(done(s('running'), s('idle', background: 2)), isEmpty);
    expect(done(s('idle', background: 2), s('idle', background: 1)), isEmpty);
    expect(done(s('idle', background: 1), s('idle')), ['a']);
    expect(done(s('running'), s('idle')), ['a']);
  });

  test('会话页那一条：只认后台在跑的子智能体和 local_agent / local_workflow 任务，按 id 去重', () {
    final list = backgroundAgents({
      'subagents': [
        {'id': 'x', 'label': '查规范', 'status': 'running', 'background': true},
        {'id': 'y', 'label': '前台的', 'status': 'running'},
        {'id': 'z', 'label': '跑完的', 'status': 'completed', 'background': true},
      ],
      'tasks': [
        {'id': 'x', 'kind': 'local_agent', 'description': '重复的'},
        {'id': 'w', 'kind': 'local_workflow', 'description': '编排'},
        {'id': 'b', 'kind': 'local_bash', 'description': '命令'},
      ],
    });
    expect([for (final a in list) a.label], ['查规范', '编排']);
    expect(list.last.workflow, isTrue);
    expect(backgroundAgents(null), isEmpty);
  });
}
