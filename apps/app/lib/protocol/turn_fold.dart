// 每轮的过程收成一行「执行」：照搬 packages/protocol/src/turnFold.ts（docs/ui/conversation-concise.md §3）。
// 一直显示：用户消息（含引导）、警告和错误、最后的回复、统计行；其余（思考、工具调用、待办、中间的过渡话、信息提示）是过程。
// 和 TS 逐项对照的样例：test/fixtures/protocol_fold.json。
import 'json.dart';

/// 折叠后的一项：单独显示的条目，或收成一行的执行块
sealed class TurnEntry {
  const TurnEntry();
}

final class ItemEntry extends TurnEntry {
  const ItemEntry(this.item);
  final Item item;
}

final class ProcessEntry extends TurnEntry {
  const ProcessEntry({
    required this.key,
    required this.items,
    required this.running,
    required this.durationMs,
  });
  final String key;
  final List<Item> items;

  /// 这一轮还在进行（只有最后一轮可能为真）
  final bool running;
  final num? durationMs;
}

/// 子智能体的显示方式（docs/ui/subagent-box.md）；interleave：中间的回复直接显示（D276，现在只有 Codex 会话开）
class FoldOptions {
  const FoldOptions({this.box = false, this.interleave = false});
  final bool box;
  final bool interleave;
}

bool _isTool(Item item) => item.isToolLike;

/// 主智能体派出子智能体的调用
bool isSubagentCall(Item item) =>
    item.kind == 'tool' && item.tool == 'task' && !truthy(item['subagent']);

/// 子智能体自己调用的工具（带 subagent 标签）：box 下不显示在主对话里
bool isSubagentWork(Item item) => item.isToolLike && truthy(item['subagent']);

/// 后台任务结束的提示带结构化信息：box 下画成完成小框
bool isTaskNotice(Item item) => item.kind == 'notice' && truthy(item['task']);

bool isSubagentBox(Item item) => isSubagentCall(item) || isTaskNotice(item);

/// 生成的图（Codex 内置生图、云端生图，docs/ui/image-gen.md）是这一轮的结果：不收进执行块。
/// 云端生图在上一轮的统计行之后单独成一轮，收进去就成了一行「执行」，图看不到
bool _generatedImage(Item item) =>
    item.kind == 'tool' &&
    (item['name'] == 'imageGeneration' || item['name'] == 'cloudImage');

bool _alwaysVisible(Item item, bool box) {
  final kind = item.kind;
  if (kind == 'user' || kind == 'turn_stats' || kind == 'compaction') {
    return true;
  }
  if (_generatedImage(item)) return true;
  if (box && isSubagentBox(item)) return true;
  return kind == 'notice' && item.level != 'info';
}

bool _trailing(Item item, bool box) {
  if (_alwaysVisible(item, box) || item.kind == 'reasoning') return true;
  if (item.kind == 'notice') return item.level == 'info';
  return item.kind == 'assistant' && jsTrim(item.text).isEmpty;
}

/// 最后的回复在这一轮里的位置；没有时 -1
int _replyIndex(List<Item> turn, bool box) {
  for (var i = turn.length - 1; i >= 0; i--) {
    final item = turn[i];
    if (item.kind == 'assistant' && jsTrim(item.text).isNotEmpty) return i;
    if (!_trailing(item, box)) return -1;
  }
  return -1;
}

bool _isTurnUser(Item item) => item.kind == 'user' && item.mode != 'guidance';

bool _interrupts(Item item, bool box) =>
    _alwaysVisible(item, box) &&
    item.kind != 'turn_stats' &&
    !_isTurnUser(item);

/// 折叠过程中的一项：单独显示的条目或一段过程
sealed class _Out {}

final class _Shown extends _Out {
  _Shown(this.item);
  final Item item;
}

final class _Segment extends _Out {
  _Segment(this.items);
  final List<Item> items;
}

List<TurnEntry> _foldTurn(
  List<Item> turn,
  bool running,
  bool box,
  bool interleave,
) {
  var reply = _replyIndex(turn, box);
  final candidate = reply >= 0 ? turn[reply] : null;
  final ended = turn.any((item) => item.kind == 'turn_stats');
  if (!interleave &&
      running &&
      !ended &&
      candidate != null &&
      candidate.kind == 'assistant') {
    final before = turn
        .sublist(0, reply)
        .any((item) => !_alwaysVisible(item, box));
    if (before) reply = -1;
  }
  bool said(Item item) =>
      interleave && item.kind == 'assistant' && jsTrim(item.text).isNotEmpty;
  bool shown(Item item, int i) =>
      i == reply || _alwaysVisible(item, box) || said(item);

  final process = [
    for (var i = 0; i < turn.length; i++)
      if (!shown(turn[i], i)) turn[i],
  ];
  // 没有工具调用、只有一条（只有一段思考、一条信息提示）：照原样显示
  if (process.isEmpty || (process.length == 1 && !_isTool(process[0]))) {
    return [for (final item in turn) ItemEntry(item)];
  }

  final out = <_Out>[];
  _Segment? segment;
  for (var i = 0; i < turn.length; i++) {
    final item = turn[i];
    if (shown(item, i)) {
      if (_interrupts(item, box) || said(item)) segment = null;
      out.add(_Shown(item));
    } else if (segment != null) {
      segment.items.add(item);
    } else {
      segment = _Segment([item]);
      out.add(segment);
    }
  }

  // 穿插时只有思考的一段并进后面最近那段有工具的（中间只隔着回复）
  if (interleave) {
    for (var i = 0; i < out.length; i++) {
      final e = out[i];
      if (e is! _Segment || e.items.any(_isTool)) continue;
      for (final f in out.skip(i + 1)) {
        if (f is _Segment) {
          if (f.items.any(_isTool)) {
            f.items.insertAll(0, e.items);
            e.items.clear();
          }
          break;
        }
        if (f is! _Shown || !said(f.item)) break;
      }
    }
  }

  Item? stats;
  for (final item in turn) {
    if (item.kind == 'turn_stats') {
      stats = item;
      break;
    }
  }
  _Segment? last;
  for (final e in out) {
    if (e is _Segment && e.items.isNotEmpty) last = e;
  }
  // 穿插时最后一段后面已经有回复了，那一段就做完了
  final from = last == null ? 0 : out.indexOf(last) + 1;
  final settled =
      interleave && out.skip(from).any((e) => e is _Shown && said(e.item));

  return [
    for (final e in out)
      ...switch (e) {
        _Shown() => [ItemEntry(e.item)],
        _Segment(items: final items) when items.isEmpty => const <TurnEntry>[],
        _Segment(items: final items)
            when (items.length == 1 || interleave) && !items.any(_isTool) =>
          [for (final item in items) ItemEntry(item)],
        _Segment(items: final items) => [
          ProcessEntry(
            key: 'process-${items[0].id}',
            items: items,
            running: running && identical(e, last) && !settled,
            durationMs: identical(e, last) && stats != null
                ? obj(stats['usage'])['durationMs'] as num?
                : null,
          ),
        ],
      },
  ];
}

/// running：会话还在进行，最后一轮没结束。按用户消息分轮
List<TurnEntry> foldTurns(
  List<Item> items,
  bool running, [
  FoldOptions options = const FoldOptions(),
]) {
  final turns = splitTurns(
    options.box ? items.where((i) => !isSubagentWork(i)).toList() : items,
  );
  return [
    for (var i = 0; i < turns.length; i++)
      ..._foldTurn(
        turns[i],
        running && i == turns.length - 1,
        options.box,
        options.interleave,
      ),
  ];
}

List<List<Item>> splitTurns(List<Item> items) {
  final turns = <List<Item>>[[]];
  for (final item in items) {
    final current = turns.last;
    final newTurn = item.kind == 'user' && item.mode != 'guidance';
    if (current.isNotEmpty && (newTurn || current.last.kind == 'turn_stats')) {
      turns.add([]);
    }
    turns.last.add(item);
  }
  return turns;
}

/// 每一轮统计行 id → 这一轮显示在外面的最后回复（「复制」用它）
Map<String, String> turnReplies(
  List<Item> items, [
  FoldOptions options = const FoldOptions(),
]) {
  final map = <String, String>{};
  final source = options.box
      ? items.where((i) => !isSubagentWork(i)).toList()
      : items;
  for (final turn in splitTurns(source)) {
    Item? stats;
    for (final item in turn) {
      if (item.kind == 'turn_stats') {
        stats = item;
        break;
      }
    }
    final i = _replyIndex(turn, options.box);
    final reply = i >= 0 ? turn[i] : null;
    if (stats != null && reply != null && reply.kind == 'assistant') {
      map[stats.id] = reply.text;
    }
  }
  return map;
}

class ProcessSummary {
  int commands = 0;

  /// 改过的文件（同一个文件算一次）
  int edits = 0;
  int reads = 0;
  int searches = 0;
  int web = 0;
  int mcp = 0;
  int agents = 0;
  int other = 0;
  int failed = 0;

  /// 被自动审核拦下、用户还没同意重试的
  int blocked = 0;

  Map<String, int> toJson() => {
    'commands': commands,
    'edits': edits,
    'reads': reads,
    'searches': searches,
    'web': web,
    'mcp': mcp,
    'agents': agents,
    'other': other,
    'failed': failed,
    'blocked': blocked,
  };
}

ProcessSummary summarizeProcess(List<Item> items) {
  final s = ProcessSummary();
  final files = <String>{};
  for (final item in items) {
    switch (item.kind) {
      case 'command':
        s.commands++;
      case 'file_change':
        for (final c in objList(item['changes'])) {
          files.add(c['path'] as String);
        }
      case 'tool':
        switch (item.tool) {
          case 'read':
            s.reads++;
          case 'search':
            s.searches++;
          case 'web':
            s.web++;
          case 'mcp':
            s.mcp++;
          case 'task':
            s.agents++;
          case 'other':
            s.other++;
        }
    }
    // 自动审核拦下、审查超时的没执行，不算失败
    final review = item.reviewStatus;
    if (item.isToolLike &&
        item.status == 'failed' &&
        review != 'denied' &&
        review != 'timedOut') {
      s.failed++;
    }
    if (item.isToolLike &&
        review == 'denied' &&
        !truthy(obj(item['review'])['overridden'])) {
      s.blocked++;
    }
  }
  s.edits = files.length;
  return s;
}
