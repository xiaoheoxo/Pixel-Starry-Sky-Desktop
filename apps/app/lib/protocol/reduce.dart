// 把事件折叠成会话快照：照搬 packages/protocol/src/reduce.ts，电脑、网页版、App 用同一套规则，结果一定一致。
// 纯函数：不修改传入的快照，返回新对象（界面靠引用变化判断要不要重画）。
// 和 TS 逐项对照的样例：test/fixtures/protocol_reduce.json（packages/protocol/test/app-fixtures.test.ts 生成）。
import 'json.dart';
import 'turn_fold.dart' show isSubagentWork;

const Json emptyFlags = {
  'ultracodeAvailable': null,
  'fastAvailable': null,
  'fastState': null,
  'fastBlocked': null,
};

Json emptySnapshot(Json record, [List<Json> items = const []]) => {
  'record': record,
  'context': null,
  'state': 'idle',
  'items': List<Json>.of(items),
  'pending': const <Json>[],
  'usage': null,
  'flags': emptyFlags,
  'tasks': const <Object?>[],
  'subagents': const <Object?>[],
  'runs': const {'workflows': <Object?>[], 'agents': <Object?>[]},
  'suggestion': null,
  'queue': const <Object?>[],
  'queuePaused': false,
  'execution': null,
  'turnId': null,
  'retry': null,
  'compaction': null,
};

/// 一轮结束时把还在跑的条目收尾；后台子智能体的工具不跟着这一轮结束
Item settle(Item item, String status) {
  final kind = item.kind;
  if (kind == 'user' || kind == 'notice' || kind == 'turn_stats') return item;
  if (item.isToolLike && truthy(item['background'])) return item;
  return item.status == 'running' ? Item({...item, 'status': status}) : item;
}

/// 增量几乎都落在最后一项：先看末尾，再从后往前找
int _indexOfId(List<Item> items, String id) {
  final last = items.length - 1;
  if (last >= 0 && items[last].id == id) return last;
  for (var i = last; i >= 0; i--) {
    if (items[i].id == id) return i;
  }
  return -1;
}

/// 这一轮之前记下的计划：同一行，或这一轮更早的清单
Item? _earlierTodo(List<Item> items, int at) {
  // TS 里 items[-1] 是 undefined
  final same = at >= 0 && at < items.length ? items[at] : null;
  if (same != null && same.kind == 'todo') return same;
  for (var i = items.length - 1; i >= 0; i--) {
    final item = items[i];
    if (item.kind == 'todo') return item;
    if (item.kind == 'user' &&
        item.mode != 'guidance' &&
        !item.containsKey('reconnect')) {
      return null;
    }
  }
  return null;
}

/// 进行中的那一步变了就记一笔（docs/ui/auto-fold.md §3）
Item _withStepMarks(List<Item> items, Item todo, int at) {
  final marks = objList(_earlierTodo(items, at)?['stepMarks']);
  String? step;
  for (final s in objList(todo['steps'])) {
    if (s['status'] == 'in_progress') {
      step = str(s['text']);
      break;
    }
  }
  final lastStep = marks.isEmpty ? null : str(marks.last['step']);
  if (step == lastStep) {
    return marks.isNotEmpty ? Item({...todo, 'stepMarks': marks}) : todo;
  }
  Item? last;
  for (var i = items.length - 1; i >= 0; i--) {
    if (items[i].kind != 'todo' && !isSubagentWork(items[i])) {
      last = items[i];
      break;
    }
  }
  return Item({
    ...todo,
    'stepMarks': [
      ...marks,
      {'step': step, 'afterItemId': last?.id},
    ],
  });
}

List<Item> _upsert(List<Item> items, Item item) {
  final i = _indexOfId(items, item.id);
  final stored = item.kind == 'todo' ? _withStepMarks(items, item, i) : item;
  if (i < 0) return [...items, stored];
  return List.of(items)..[i] = stored;
}

List<Item> _items(Json s) => itemsOf(s['items']);

bool _recordChanged(Json old, Json next) =>
    next['model'] != old['model'] ||
    next['engine'] != old['engine'] ||
    stringifyField(next, 'platform') != stringifyField(old, 'platform') ||
    obj(next['provider'])['id'] != obj(old['provider'])['id'];

/// 事件 → 新快照。电脑新版本加了 App 不认识的事件时原样返回（TS 的类型是穷尽的，没有这一支）
Json reduce(Json s, Json e) {
  switch (e['type']) {
    case 'context':
      return {...s, 'context': e['context']};
    case 'request_retry':
      final retry = objOrNull(e['retry']);
      return retry == null || retry['turnId'] == s['turnId']
          ? {...s, 'retry': e['retry']}
          : s;
    case 'compaction_progress':
      return {...s, 'compaction': e['progress']};
    case 'request_usage':
    case 'request_cache_reset':
    case 'input_ack':
      return s;
    case 'status':
      return s['state'] == e['state'] ? s : {...s, 'state': e['state']};
    case 'record':
      final record = obj(e['record']);
      final context = objOrNull(s['context']);
      return {
        ...s,
        'record': record,
        if (context != null && _recordChanged(obj(s['record']), record))
          'context': {...context, 'stale': true, 'diagnosticStale': true},
      };
    case 'turn_started':
      return {
        ...s,
        'turnId': e['turnId'],
        'execution': e['execution'],
        'retry': null,
        'compaction': null,
      };
    case 'execution':
      return {...s, 'execution': e['settings']};
    case 'queue':
      return {...s, 'queue': e['items'], 'queuePaused': e['paused']};
    case 'items_truncated':
      final items = _items(s);
      final i = _indexOfId(items, e['fromItemId'] as String);
      return i < 0 ? s : {...s, 'items': items.sublist(0, i)};
    case 'items_reset':
      return {...s, 'items': e['items']};
    case 'item_started':
    case 'item_completed':
      return {...s, 'items': _upsert(_items(s), Item(obj(e['item'])))};
    case 'item_delta':
      final items = _items(s);
      final i = _indexOfId(items, e['itemId'] as String);
      if (i < 0) return s;
      final item = items[i];
      final field = e['field'];
      final delta = e['delta'] as String;
      Item next;
      if (field == 'text' &&
          (item.kind == 'assistant' || item.kind == 'reasoning')) {
        next = Item({...item, 'text': item.text + delta});
      } else if (field == 'output' &&
          (item.kind == 'command' || item.kind == 'tool') &&
          !item.containsKey('cutChars')) {
        // 输出截过的只留头尾，接上去就不是原文
        next = Item({...item, 'output': (str(item['output']) ?? '') + delta});
      } else {
        return s;
      }
      return {...s, 'items': List<Item>.of(items)..[i] = next};
    case 'approval_request':
      final request = obj(e['request']);
      return {
        ...s,
        'pending': [
          ...objList(s['pending'])
              .where((p) => p['requestId'] != request['requestId']),
          request,
        ],
      };
    case 'approval_resolved':
      return {
        ...s,
        'pending': [
          ...objList(s['pending'])
              .where((p) => p['requestId'] != e['requestId']),
        ],
      };
    case 'usage':
      return {...s, 'usage': e['usage']};
    case 'flags':
      return {...s, 'flags': e['flags']};
    case 'tasks':
      return {...s, 'tasks': e['tasks']};
    case 'subagents':
      return {...s, 'subagents': e['subagents']};
    case 'background':
      return (s['background'] ?? 0) == e['count']
          ? s
          : {...s, 'background': e['count']};
    case 'runs':
      return {...s, 'runs': e['runs']};
    case 'suggestion':
      return s['suggestion'] == e['text'] ? s : {...s, 'suggestion': e['text']};
    case 'commands':
      return {...s, 'commands': e['commands']};
    case 'goal':
      return {...s, 'goal': e['goal']};
    case 'mcp':
      return {...s, 'mcp': e['report']};
    case 'turn_completed':
      final outcome = e['outcome'];
      final status = outcome == 'interrupted'
          ? 'interrupted'
          : outcome == 'failed'
          ? 'failed'
          : 'completed';
      final items = _items(s);
      final settled = [for (final x in items) settle(x, status)];
      var changed = false;
      for (var i = 0; i < items.length; i++) {
        if (!identical(settled[i], items[i])) changed = true;
      }
      return {
        ...s,
        'turnId': null,
        'retry': null,
        'compaction': null,
        'execution': null,
        'pending': const <Json>[],
        'items': changed ? settled : s['items'],
      };
  }
  return s;
}
