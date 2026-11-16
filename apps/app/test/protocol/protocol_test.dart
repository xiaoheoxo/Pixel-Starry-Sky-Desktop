// 协议纯函数和 TS 逐项对照：样例由 packages/protocol/test/app-fixtures.test.ts 导出（node scripts/export-app-fixtures.mjs）
import 'dart:convert';

import 'package:collection/collection.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/protocol/codex_directives.dart';
import 'package:pixelsky_app/protocol/constants.dart';
import 'package:pixelsky_app/protocol/errors.dart';
import 'package:pixelsky_app/protocol/json.dart';
import 'package:pixelsky_app/protocol/reduce.dart';
import 'package:pixelsky_app/protocol/turn_fold.dart';

import '../link/fixtures.dart';

const _deep = DeepCollectionEquality();

/// 比较两个 JSON 值；不同时把两边都打出来
void expectJson(Object? actual, Object? expected, String where) {
  if (_deep.equals(_normalize(actual), _normalize(expected))) return;
  fail('$where 和 TS 不一致\n实际：${jsonEncode(actual)}\n期望：${jsonEncode(expected)}');
}

/// 走一遍 JSON 编解码：Item 等包装类型、int / double 的差别都抹平
Object? _normalize(Object? v) => jsonDecode(jsonEncode(v));

const _foldOptions = {
  'default': FoldOptions(),
  'box': FoldOptions(box: true),
  'interleave': FoldOptions(interleave: true),
  'box+interleave': FoldOptions(box: true, interleave: true),
};

List<Map<String, Object?>> _compact(List<TurnEntry> entries) => [
  for (final e in entries)
    switch (e) {
      ItemEntry(:final item) => {'type': 'item', 'id': item.id},
      ProcessEntry() => {
        'type': 'process',
        'key': e.key,
        'ids': [for (final i in e.items) i.id],
        'running': e.running,
        'durationMs': e.durationMs,
      },
    },
];

/// TS 里 durationMs 为 undefined 时 JSON 没有这个键
Object? _withNullDuration(Object? entries) => [
  for (final e in entries as List)
    if ((e as Map)['type'] == 'process')
      {...e, 'durationMs': e['durationMs']}
    else
      e,
];

void main() {
  group('reduce', () {
    final f = fixture('protocol_reduce.json');
    for (final c in cases(f, 'cases')) {
      test('种子 ${c['seed']}', () {
        var s = obj(c['start']);
        final events = objList(c['events']);
        final checkpoints = objList(c['checkpoints']);
        var k = 0;
        for (final cp in checkpoints) {
          final after = cp['after'] as int;
          for (; k < after; k++) {
            s = reduce(s, events[k]);
          }
          expectJson(s, cp['snapshot'], '第 $after 个事件之后的快照');
        }
      });
    }

    test('不修改传入的快照', () {
      final start = emptySnapshot({'id': 's'});
      final before = jsonEncode(start);
      final item = {
        'kind': 'assistant',
        'id': 'a',
        'text': 'x',
        'status': 'running',
      };
      var s = reduce(start, {'type': 'item_started', 'item': item});
      s = reduce(s, {
        'type': 'item_delta',
        'itemId': 'a',
        'field': 'text',
        'delta': 'y',
      });
      expect(jsonEncode(start), before);
      expect(item['text'], 'x');
      expect(Item(objList(s['items']).single).text, 'xy');
    });

    test('认不出的事件原样返回', () {
      final s = emptySnapshot({'id': 's'});
      expect(identical(reduce(s, {'type': 'from_the_future'}), s), isTrue);
    });
  });

  group('foldTurns', () {
    final f = fixture('protocol_fold.json');
    var n = 0;
    for (final c in cases(f, 'cases')) {
      final index = n++;
      test('用例 $index', () {
        final items = itemsOf(c['items']);
        expectJson(
          [
            for (final t in splitTurns(items)) [for (final i in t) i.id],
          ],
          c['splitTurns'],
          'splitTurns',
        );
        for (final v in objList(c['fold'])) {
          final options = _foldOptions[v['options']]!;
          final running = v['running'] as bool;
          expectJson(
            _compact(foldTurns(items, running, options)),
            _withNullDuration(v['entries']),
            'foldTurns(${v['options']}, running: $running)',
          );
        }
        for (final r in objList(c['replies'])) {
          final map = turnReplies(items, _foldOptions[r['options']]!);
          expectJson(
            [
              for (final e in map.entries) {'statsId': e.key, 'text': e.value},
            ],
            r['map'],
            'turnReplies(${r['options']})',
          );
        }
        expectJson(
          summarizeProcess(items).toJson(),
          c['summary'],
          'summarizeProcess',
        );
      });
    }
  });

  group('文字', () {
    final f = fixture('protocol_text.json');
    for (final c in cases(f, 'errors')) {
      test('错误代码：${jsonEncode(c['input'])}', () {
        final input = c['input'] as String;
        final parsed = parseCodedError(input);
        expectJson(
          parsed == null
              ? null
              : {'code': parsed.code, 'params': parsed.params},
          c['parsed'],
          'parseCodedError',
        );
        expect(
          replaceCodedErrors(
            input,
            (i) => '[${i.code}|${jsonEncode(i.params)}]',
          ),
          c['replaced'],
        );
      });
    }
    for (final c in cases(f, 'codex')) {
      test('Codex 标记：${jsonEncode(c['input'])}', () {
        expect(
          replaceCodexDirectives(
            c['input'] as String,
            (x) => '[[${x.path}|${jsonEncode(x.attributes)}]]',
          ),
          c['output'],
        );
      });
    }
    test('citationName', () {
      for (final c in cases(f, 'citations')) {
        expect(
          citationName(c['path'] as String),
          c['name'],
          reason: '${c['path']}',
        );
      }
    });
    test('diffStat', () {
      for (final c in cases(f, 'diffs')) {
        final s = diffStat(objList(c['changes']));
        expectJson(
          {'added': s.added, 'removed': s.removed},
          c['stat'],
          'diffStat',
        );
      }
    });
  });

  test('常量', () {
    final f = fixture('protocol_constants.json');
    expect(chatProjectId, f['chatProjectId']);
    expect(errorPrefix, f['errorPrefix']);
    expect(permissionModes, f['permissionModes']);
    expect(efforts, f['efforts']);
    final expected = cases(f, 'engines');
    expect(engines.keys.toList(), [for (final e in expected) e['id']]);
    for (final e in expected) {
      final d = engines[e['id']]!;
      final caps = obj(e['caps']);
      expect(
        {
          'name': d.name,
          'short': d.short,
          'permissionModes': d.permissionModes,
          'efforts': d.efforts,
          'imageInput': d.imageInput,
          'interrupt': d.interrupt,
          'steer': d.steer,
          'ultracode': d.ultracode,
          'fast': d.fast,
          'thinkingSummaries': d.thinkingSummaries,
          'liveModelSwitch': d.liveModelSwitch,
          'livePermissionSwitch': d.livePermissionSwitch,
        },
        {
          'name': e['name'],
          'short': e['short'],
          'permissionModes': caps['permissionModes'],
          'efforts': caps['efforts'],
          'imageInput': caps['imageInput'],
          'interrupt': caps['interrupt'],
          'steer': caps['steer'],
          'ultracode': caps['ultracode'],
          'fast': caps['fast'],
          'thinkingSummaries': caps['thinkingSummaries'],
          'liveModelSwitch': caps['liveModelSwitch'],
          'livePermissionSwitch': caps['livePermissionSwitch'],
        },
        reason: '${e['id']}',
      );
    }
  });
}
