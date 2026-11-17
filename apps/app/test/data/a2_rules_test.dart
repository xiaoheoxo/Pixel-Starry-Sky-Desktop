// A2 的纯函数：用例照网页版 apps/mobile/src/data/{queue,questions,mode,retry,context}.test.ts（规则必须一致）。
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/data/mode.dart';
import 'package:pixelsky_app/data/queue.dart';
import 'package:pixelsky_app/data/questions.dart';
import 'package:pixelsky_app/data/retry.dart';
import 'package:pixelsky_app/protocol/json.dart';

Queued q(String id, [Json patch = const {}]) => Queued({
  'id': id,
  'text': id,
  'createdAt': 0,
  'settings': <String, Object?>{},
  'status': 'queued',
  'error': null,
  'mode': 'normal',
  ...patch,
});

List<String> ids(List<Queued> list) => [for (final x in list) x.id];

Question question(String text, List<String> labels, [bool multi = false]) =>
    Question({
      'question': text,
      'header': '',
      'multiSelect': multi,
      'options': [
        for (final l in labels) {'label': l, 'description': ''},
      ],
    });

void main() {
  group('消息队列', () {
    test('不显示正在执行的，也不显示空闲时直接发送、正在启动的', () {
      final queue = [
        q('run', {'status': 'running'}),
        q('direct', {'direct': true}),
        q('wait'),
        q('fail', {'direct': true, 'status': 'failed'}),
      ];
      expect(ids(queueItems({'queue': queue, 'queuePaused': false})), [
        'wait',
        'fail',
      ]);
      expect(ids(queueItems({'queue': queue, 'queuePaused': true})), [
        'direct',
        'wait',
        'fail',
      ]);
    });

    test('每条的状态和标题', () {
      expect(queueLabel(q('a')), '排队中');
      expect(queueLabel(q('a', {'held': true})), '已暂停');
      expect(queueLabel(q('a', {'direct': true, 'status': 'failed'})), '发送失败');
      expect(queueLabel(q('a', {'status': 'failed'})), '执行失败');
      expect(queueLabel(q('a', {'status': 'uncertain'})), '待核对');
      expect(
        queueTitle([
          q('a', {'direct': true, 'status': 'failed'}),
        ], false),
        '发送失败',
      );
      expect(queueTitle([q('a')], true), '队列已暂停');
      expect(
        queueTitle([
          q('a', {'held': true}),
        ], false),
        '队列已暂停',
      );
      expect(queueTitle([q('a')], false), '排队中');
      expect(isPending(q('a', {'status': 'delivering'})), true);
    });

    test('自动重连中的那条', () {
      const reconnect = {'attempt': 2, 'max': 5, 'at': 10, 'since': 0};
      expect(isReconnecting(q('a', {'reconnect': reconnect})), true);
      expect(
        isReconnecting(q('a', {'reconnect': reconnect, 'held': true})),
        false,
      );
      expect(queueLabel(q('a', {'reconnect': reconnect})), '正在重连 2/5');
      expect(queueLabel(q('a', {'reconnect': reconnect}), true), '重连已暂停 2/5');
      expect(queueLabel(q('a', {'reconnect': reconnect, 'held': true})), '已暂停');
    });

    test('额度用完在等到点继续', () {
      const reconnect = {
        'attempt': 1,
        'max': 3,
        'at': 10,
        'since': 0,
        'limited': true,
      };
      final waiting = q('a', {'reconnect': reconnect});
      expect(isLimitWait(waiting), true);
      expect(queueLabel(waiting), '等额度恢复');
      final limit = {
        'kind': 'quota',
        'resetsAt': DateTime.now().millisecondsSinceEpoch + 3600000,
        'tries': <int>[],
      };
      expect(
        queueLabel(q('a', {'reconnect': reconnect, 'limit': limit})),
        matches(RegExp(r'^等额度恢复（.+）$')),
      );
      expect(queueLabel(waiting, true), '等待已暂停');
      expect(limitNote(waiting, true), '不会自己继续，可以现在试一次');
      final stopped = q('a', {
        'reconnect': reconnect,
        'limit': {
          ...limit,
          'tries': [1, 2, 3],
        },
      });
      expect(queueLabel(stopped), '自动继续已停止');
      final rate = q('a', {
        'reconnect': reconnect,
        'limit': {...limit, 'kind': 'rate', 'resetsAt': null},
      });
      expect(queueLabel(rate), '等限流结束');
      expect(limitNote(rate, false), '请求太频繁，到点自动继续');
      expect(limitNote(waiting, false), '额度用完，到点自动继续');
    });

    test('插话：要排队中、引擎支持、正在跑一轮', () {
      final running = {
        'state': 'running',
        'turnId': 't1',
        'flags': {'steerAvailable': true},
      };
      expect(canSteer(q('a'), running), true);
      expect(canSteer(q('a', {'status': 'failed'}), running), false);
      expect(
        canSteer(q('a'), {
          ...running,
          'flags': {'steerAvailable': false},
        }),
        false,
      );
      expect(
        canSteer(q('a'), {...running, 'state': 'idle', 'turnId': null}),
        false,
      );
    });

    test('调序按邻居的 id 算', () {
      final list = [q('a'), q('b'), q('c')];
      expect(queueMoveTarget(list, 'b', -1), {'before': 'a'});
      expect(queueMoveTarget(list, 'a', 1), {'before': 'c'});
      expect(queueMoveTarget(list, 'b', 1), {'before': null});
      expect(queueMoveTarget(list, 'a', -1), same(noMove));
      expect(queueMoveTarget(list, 'c', 1), same(noMove));
      expect(
        queueMoveTarget(
          [
            q('a', {'status': 'delivering'}),
            q('b'),
          ],
          'b',
          -1,
        ),
        same(noMove),
      );
      final r = [
        q('r', {
          'reconnect': {'attempt': 1, 'max': 3, 'at': 0},
        }),
        q('b'),
        q('c'),
      ];
      expect(queueMoveTarget(r, 'b', -1), same(noMove));
      expect(queueMoveTarget(r, 'b', 1), {'before': null});
    });

    test('旧版电脑发下标', () {
      final queue = [
        q('a', {'status': 'running'}),
        q('b'),
        q('c'),
        q('d'),
      ];
      final items = queue.sublist(1);
      expect(queueMoveArg(queue, items, 'c', -1, true), {'before': 'b'});
      expect(queueMoveArg(queue, items, 'c', 1, true), {'before': null});
      expect(queueMoveArg(queue, items, 'c', -1, false), 1);
      expect(queueMoveArg(queue, items, 'c', 1, false), 3);
      expect(queueMoveArg(queue, items, 'b', -1, false), 0);
      expect(queueMoveArg(queue, items, 'd', 1, false), same(noMove));
      expect(queueMoveArg(queue, items, 'a', -1, false), same(noMove));
    });

    test('「队列已变化」写成中文', () {
      expect(
        queueErrorText('PIXELSKY_ERR:{"code":"queue.changed"}'),
        '队列已变化，排序未保存',
      );
      expect(
        queueErrorText('Error: PIXELSKY_ERR:{"code":"queue.changed"}'),
        'Error: 队列已变化，排序未保存',
      );
      expect(queueErrorText('只有排队中的消息可以调序'), '只有排队中的消息可以调序');
    });
  });

  group('提问', () {
    test('推荐记号', () {
      expect(isRecommended('7 天（推荐）'), true);
      expect(isRecommended('Keep it (Recommended)'), true);
      expect(isRecommended('30 天'), false);
      expect(displayLabel('7 天（推荐）'), '7 天');
      expect(displayLabel('Keep it (Recommended)'), 'Keep it');
    });

    test('都按推荐', () {
      expect(
        recommendedAnswers([
          question('多久', ['7 天（推荐）', '30 天']),
          question('提示', ['一行字 (推荐)', '小圆点（推荐）', '不提示'], true),
        ]),
        {'多久': '7 天（推荐）', '提示': '一行字 (推荐), 小圆点（推荐）'},
      );
      expect(
        recommendedAnswers([
          question('多久', ['7 天（推荐）']),
          question('提示', ['一行字', '小圆点']),
        ]),
        isNull,
      );
      expect(recommendedAnswers([]), isNull);
    });

    test('单选的「其他」', () {
      final single = Question({
        ...question('部署方式？', ['给你 SSH 访问', '我自己执行']),
        'allowOther': true,
      });
      var d = pickOption(single, emptyDraft, '我自己执行');
      expect(draftAnswer(single, d), '我自己执行');
      d = toggleOther(single, d);
      expect(d.picks, isEmpty);
      expect(d.other, true);
      expect(draftAnswer(single, d), isNull);
      d = d.copyWith(text: '  先发我脚本看看  ');
      expect(draftAnswer(single, d), '先发我脚本看看');
      d = pickOption(single, d, '给你 SSH 访问');
      expect(d.other, false);
      expect(draftAnswer(single, d), '给你 SSH 访问');
    });

    test('多选的「其他」和没有选项的题', () {
      final multi = Question({
        ...question('要哪些？', ['日志', '托盘'], true),
        'allowOther': true,
      });
      var d = pickOption(multi, emptyDraft, '日志');
      d = toggleOther(multi, d).copyWith(text: '设置同步');
      expect(draftAnswer(multi, d), '日志, 设置同步');
      d = toggleOther(multi, d);
      expect(draftAnswer(multi, d), '日志');

      final open = question('还有什么要求？', []);
      expect(canWriteIn(open), true);
      expect(canWriteIn(question('二选一', ['a', 'b'])), false);
      final single = question('部署方式？', ['我自己执行']);
      expect(
        collectAnswers(
          [single, open],
          {single.question: pickOption(single, emptyDraft, '我自己执行')},
        ),
        isNull,
      );
      expect(
        collectAnswers(
          [single, open],
          {
            single.question: pickOption(single, emptyDraft, '我自己执行'),
            open.question: const QuestionDraft(text: '没有'),
          },
        ),
        {single.question: '我自己执行', open.question: '没有'},
      );
    });
  });

  group('模式', () {
    test('胶囊文字', () {
      String p(String mode) =>
          modeChip({'permissionMode': mode, 'model': null, 'effort': null})
              .permission;
      expect(
        [p('ask'), p('edits'), p('plan'), p('full')],
        ['每步问我', '自动改文件', '先出计划 · 每步问我', '完全放行'],
      );
      final chip = modeChip({
        'permissionMode': 'edits',
        'model': 'claude-sonnet-4-5-20250929',
        'effort': 'medium',
      });
      expect(chip.model, 'Sonnet 4.5');
      expect(chip.effort, '中');
      expect(modeChip({'permissionMode': 'ask'}).model, isNull);
    });

    test('「先出计划」是开关，不是一档；计划中显示批准后回到哪档', () {
      expect(permissionOptions('claude', 'ask').map((o) => o.value), [
        'ask',
        'edits',
      ]);
      final planning = {'permissionMode': 'plan', 'planReturn': 'edits'};
      expect(inPlan(planning), true);
      expect(planReturnOf(planning), 'edits');
      // 旧记录 / 旧电脑：没有 planReturn，批准后回每步问我
      expect(planReturnOf({'permissionMode': 'plan'}), 'ask');
      expect(modeChip(planning).permission, '先出计划 · 自动改文件');
      expect(planAfterText(planning), '批准后按「自动改文件」去做');
      // 电脑上是完全放行：手机上批准回到自动改文件，关掉开关也一样
      final full = {'permissionMode': 'plan', 'planReturn': 'full'};
      expect(planAfterText(full), contains('电脑上是完全放行'));
      expect(approvedOnPhone('full'), 'edits');
      expect(approvedOnPhone('auto'), 'auto');
      expect(planOffMode('full'), 'edits');
      expect(planOffMode('auto'), 'edits');
      expect(planOffMode('ask'), 'ask');
    });

    test('电脑上开着完全放行 / 自动审核：列出来但选不了', () {
      for (final current in ['full', 'auto']) {
        expect(
          permissionOptions('codex', current).last,
          ModeOption(
            current,
            current == 'full' ? '完全放行' : '自动审核',
            hint: '只能在电脑上打开',
            disabled: true,
          ),
        );
      }
      expect(permissionOptions('codex', 'ask').any((o) => o.disabled), false);
      expect(permissionOptions('claude', null).first.value, '');
      expect(widens('ask', 'edits'), true);
      expect(widens('edits', 'plan'), false);
      expect(widens(null, 'edits'), true);
    });

    test('模型名', () {
      expect(modelLabel('claude-opus-4-1-20250805'), 'Opus 4.1');
      expect(modelLabel('claude-sonnet-4-20250514'), 'Sonnet 4');
      expect(modelLabel('claude-3-5-haiku-20241022'), 'Haiku 3.5');
      expect(modelLabel('sonnet'), 'Sonnet');
      expect(modelLabel('claude-opus-4-1[1m]'), 'Opus 4.1');
      expect(modelLabel('gpt-5'), 'gpt-5');
      expect(
        modelLabel('my-custom-model-with-a-long-name'),
        'my-custom-model-…',
      );
    });

    test('模型和强度选项', () {
      final models = [
        EngineModel({
          'id': 'claude-opus-4-1',
          'label': 'Opus 4.1',
          'efforts': ['low', 'high'],
        }),
      ];
      expect(
        [for (final o in modelOptions(models, 'custom-x')) o.value],
        ['', 'claude-opus-4-1', 'custom-x'],
      );
      expect(
        [for (final o in effortOptions('claude', models.first, 'max')) o.value],
        ['', 'low', 'high', 'max'],
      );
      expect(
        [for (final o in effortOptions('antigravity', null, null)) o.value],
        ['', 'low', 'medium', 'high'],
      );
    });

    test('快速模式', () {
      Json f(bool? available, String? state, String? blocked) => {
        'fastAvailable': available,
        'fastState': state,
        'fastBlocked': blocked,
      };
      final def = fastStatus(null);
      expect(def.available, true);
      expect(def.hint, '回复更快，按更高的价格计费');
      expect(def.warn, false);
      final blocked = fastStatus(f(false, null, 'preference'));
      expect(blocked.available, false);
      expect(blocked.hint, '暂时不可用：账号没有开启 Fast 模式');
      expect(fastStatus(f(false, null, 'something_new')).hint, '暂时不可用：原因未知');
      final cool = fastStatus(f(true, 'cooldown', null));
      expect(cool.cooldown, true);
      expect(cool.warn, true);
      expect(
        fastStatus(f(true, 'on', 'codex_gateway')).hint,
        '接口支持 Fast 时生效，不支持的打开了也没有效果',
      );
    });

    test('上下文用量', () {
      Json c(Json patch) => {
        'used': 124000,
        'window': 200000,
        'stale': false,
        'compacting': false,
        ...patch,
      };
      final u = contextUsage(c({}))!;
      expect(u.percent, 62);
      expect(contextUsage(null), isNull);
      expect(contextUsage(c({'stale': true})), isNull);
      expect(contextUsage(c({'compacting': true})), isNull);
      expect(contextUsage(c({'used': null})), isNull);
      expect(contextUsage(c({'window': 0})), isNull);
      expect(contextUsage(c({'window': double.infinity})), isNull);
      expect(contextUsage(c({'used': double.nan})), isNull);
      expect(contextUsage(c({'used': 250000}))!.percent, 100);
      expect(contextNumber(999), '999');
      expect(contextNumber(124000), '124k');
      expect(contextNumber(1500), '1.5k');
      expect(contextNumber(1200000), '1.2M');
      expect(contextLabel(u), contains('62%'));
      expect(contextLabel(u), contains('124k / 200k'));
    });
  });

  group('重试沿用 clientMessageId', () {
    var n = 0;
    String newId() => 'id-${++n}';
    test('同样的内容沿用，变了就换', () {
      final first = attemptFor(null, sendKey('s1', '你好', ['img1']), newId);
      expect(
        attemptFor(first, sendKey('s1', '你好', ['img1']), newId),
        same(first),
      );
      expect(
        attemptFor(first, sendKey('s1', '你好啊', ['img1']), newId).id,
        isNot(first.id),
      );
      expect(
        attemptFor(first, sendKey('s2', '你好', ['img1']), newId).id,
        isNot(first.id),
      );
      expect(
        attemptFor(null, sendKey('s1', '你好', []), newId).id,
        isNot(attemptFor(null, sendKey('s1', '你好', []), newId).id),
      );
    });
    test('uuid 是 v4 格式', () {
      expect(
        uuid(),
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          ),
        ),
      );
    });
  });
}
