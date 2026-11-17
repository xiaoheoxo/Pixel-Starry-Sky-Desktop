// 对话里每一项怎么画（规则照网页版 features/session/ItemView.tsx、data/turns.ts；布局参考 DSH Go 的截图，docs/mobile-app.md §8.1）：
// 你的消息是右侧灰色气泡，回复是正文；过程运行中一步一行列出来，做完折成「已完成 · 摘要」一行、点开就地展开；
// 一轮结束后回复下面一行「复制 … 用时 · 步数 · 用量」，改了文件再接一张改动卡片；出错的那条提示下面有「重试」。
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../data/reviews.dart';
import '../../i18n/i18n.dart';
import '../../protocol/constants.dart';
import '../../protocol/json.dart';
import '../../protocol/turn_fold.dart';
import '../../ui/markdown.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import 'message_images.dart';

/// 一段时间说成「N 秒」「M 分 S 秒」
String spanText(num ms) {
  final s = (ms / 1000).round().clamp(1, 1 << 40);
  if (s < 60) return L('$s 秒', '${s}s');
  return L('${s ~/ 60} 分 ${s % 60} 秒', '${s ~/ 60}m ${s % 60}s');
}

/// 一步的简短说明
String stepTitle(Item item) => switch (item.kind) {
  'command' =>
    (str(item['description']) ?? '').isNotEmpty
        ? str(item['description'])!
        : str(item['command']) ?? '',
  // 读取、搜索、上网前面已经有动作词，只写内容；别的工具带上工具名
  'tool' =>
    (str(item['title']) ?? '').isEmpty
        ? str(item['name']) ?? ''
        : const ['read', 'search', 'web'].contains(item.tool)
        ? str(item['title'])!
        : '${str(item['name']) ?? ''} · ${str(item['title'])}',
  'file_change' => [
    for (final c in objList(item['changes'])) _base(str(c['path']) ?? ''),
  ].join('、'),
  'reasoning' => _firstLine(item.text),
  'todo' => L('更新计划', 'Updated plan'),
  'compaction' => L('压缩上下文', 'Compacting context'),
  'notice' => item.text,
  'assistant' => _firstLine(item.text),
  _ => item.kind,
};

String _firstLine(String s) {
  final t = jsTrim(s);
  final i = t.indexOf('\n');
  return i < 0 ? t : t.substring(0, i);
}

String _base(String path) {
  final i = path.lastIndexOf(RegExp(r'[/\\]'));
  return i < 0 ? path : path.substring(i + 1);
}

/// 一步前面的动作词：运行 · 修改 · 读取 · 搜索 · 上网 · 子智能体 · 思考
String stepVerb(Item item) => switch (item.kind) {
  'command' => L('运行', 'Run'),
  'file_change' => L('修改', 'Edit'),
  'reasoning' => L('思考', 'Think'),
  'assistant' => L('说明', 'Note'),
  'todo' => L('计划', 'Plan'),
  'tool' => switch (item.tool) {
    'read' => L('读取', 'Read'),
    'search' => L('搜索', 'Search'),
    'web' => L('上网', 'Web'),
    'task' => L('子智能体', 'Subagent'),
    _ => L('工具', 'Tool'),
  },
  _ => '',
};

IconData stepIcon(Item item) => switch (item.kind) {
  'command' => Icons.terminal,
  'file_change' => Icons.edit_note,
  'reasoning' => Icons.psychology_outlined,
  'todo' => Icons.checklist,
  'assistant' => Icons.chat_bubble_outline,
  'compaction' => Icons.compress,
  'tool' => switch (item.tool) {
    'read' => Icons.description_outlined,
    'search' => Icons.search,
    'web' => Icons.public,
    'task' => Icons.account_tree_outlined,
    _ => Icons.build_outlined,
  },
  _ => Icons.circle_outlined,
};

/// 主智能体的步数：命令、工具、改文件（不含子智能体名下的、派出子智能体的调用本身）
int stepCount(List<Item> items) => items
    .where(
      (i) =>
          (i.kind == 'command' ||
              i.kind == 'file_change' ||
              (i.kind == 'tool' && i.tool != 'task')) &&
          !truthy(i['subagent']),
    )
    .length;

/// 过程行的摘要：「4 步 · 改了 2 个文件 +40 −12 · 1 个子智能体 · 1 步失败」
String processSummary(List<Item> items) {
  final steps = stepCount(items);
  final s = summarizeProcess(items);
  final changes = [
    for (final i in items)
      if (i.kind == 'file_change') ...objList(i['changes']),
  ];
  final parts = [
    if (steps > 0) L('$steps 步', steps == 1 ? '1 step' : '$steps steps'),
    if (s.edits > 0)
      () {
        final d = diffStat(changes);
        return L(
          '改了 ${s.edits} 个文件 +${d.added} −${d.removed}',
          '${s.edits} files +${d.added} −${d.removed}',
        );
      }(),
    if (s.agents > 0) L('${s.agents} 个子智能体', '${s.agents} subagents'),
    if (s.failed > 0) L('${s.failed} 步失败', '${s.failed} failed'),
  ];
  return parts.isEmpty ? L('思考', 'Thought') : parts.join(' · ');
}

/// 用量数字：中文「3.4 万」，英文「34k」
String tokenText(num n) {
  if (language.value == AppLanguage.zh) {
    if (n >= 10000) {
      final w = n / 10000;
      return '${w >= 100 ? w.round() : w.toStringAsFixed(1).replaceFirst(RegExp(r'\.0$'), '')} 万';
    }
    return '$n';
  }
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
  if (n >= 1000) return '${(n / 1000).round()}k';
  return '$n';
}

/// 一轮的总用量（各模型的输入、缓存、输出加起来）
num turnTokens(Item stats) {
  num total = 0;
  for (final m in obj(obj(stats['usage'])['models']).values) {
    final u = obj(m);
    for (final k in const ['input', 'cacheRead', 'cacheWrite', 'output']) {
      final v = u[k];
      if (v is num) total += v;
    }
  }
  return total;
}

/// 会话页算好、条目要用的：每轮的条目、要复制的回复、重试
class TurnContext {
  const TurnContext({
    this.turns = const {},
    this.replies = const {},
    this.retryId,
    this.retrying = false,
    this.onRetry,
    this.onUserMenu,
    this.review,
  });

  /// 统计行 id → 这一轮的全部条目
  final Map<String, List<Item>> turns;

  /// 统计行 id → 这一轮的最后回复
  final Map<String, String> replies;

  /// 「重试」挂在哪条错误提示上
  final String? retryId;
  final bool retrying;
  final VoidCallback? onRetry;

  /// 长按自己的消息：弹出菜单（编辑重发、复制）；null 时长按不做事
  final void Function(Item item)? onUserMenu;

  /// 这一轮的审查卡（C4）：参数是轮次 key（这一轮开头那条用户消息的 id），没审过的返回空
  final Widget Function(String turnKey)? review;

  static TurnContext of(List<Item> items) {
    final turns = <String, List<Item>>{};
    for (final turn in splitTurns(items)) {
      for (final i in turn) {
        if (i.kind == 'turn_stats') turns[i.id] = turn;
      }
    }
    return TurnContext(turns: turns, replies: turnReplies(items));
  }

  TurnContext withRetry(String? id, bool retrying, VoidCallback onRetry) =>
      TurnContext(
        turns: turns,
        replies: replies,
        retryId: id,
        retrying: retrying,
        onRetry: onRetry,
        onUserMenu: onUserMenu,
        review: review,
      );

  TurnContext withUserMenu(void Function(Item item) onUserMenu) => TurnContext(
    turns: turns,
    replies: replies,
    retryId: retryId,
    retrying: retrying,
    onRetry: onRetry,
    onUserMenu: onUserMenu,
    review: review,
  );

  TurnContext withReview(Widget Function(String turnKey) review) => TurnContext(
    turns: turns,
    replies: replies,
    retryId: retryId,
    retrying: retrying,
    onRetry: onRetry,
    onUserMenu: onUserMenu,
    review: review,
  );
}

/// 「重试」挂在哪条错误上：最近一轮的最后一条错误；正在运行、队列里还有消息时不给（同网页版 retryNoticeId）
String? retryNoticeId(List<Item> items, bool running, int queued) {
  if (running || queued > 0) return null;
  for (final it in items.reversed) {
    if (it.kind == 'user') return null;
    if (it.kind == 'notice' && it.level == 'error') return it.id;
  }
  return null;
}

/// 一项在列表里的身份：单条用条目 id，过程用 process-第一条的 id
String entryKey(TurnEntry e) => switch (e) {
  ItemEntry(:final item) => item.id,
  ProcessEntry(:final key) => key,
};

class EntryView extends StatelessWidget {
  const EntryView(this.entry, {super.key, this.context = const TurnContext()});
  final TurnEntry entry;
  final TurnContext context;

  @override
  Widget build(BuildContext _) => switch (entry) {
    ItemEntry(:final item) => ItemView(item, turn: context),
    final ProcessEntry p => ProcessBlock(p),
  };
}

class ItemView extends StatelessWidget {
  const ItemView(this.item, {super.key, this.turn = const TurnContext()});
  final Item item;
  final TurnContext turn;

  @override
  Widget build(BuildContext context) {
    switch (item.kind) {
      case 'user':
        if (item.containsKey('reconnect')) {
          return _Small(
            L('连接中断后自动继续', 'Continued after reconnecting'),
            icon: Icons.refresh,
          );
        }
        final menu = turn.onUserMenu;
        return UserBubble(
          text: item.text,
          itemId: item.id,
          imageMeta: objList(item['attachments']),
          guidance: item.mode == 'guidance',
          onLongPress: menu == null ? null : () => menu(item),
        );
      case 'assistant':
        if (jsTrim(item.text).isEmpty) return const SizedBox();
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: ReplyMarkdown(item.text),
        );
      case 'reasoning':
        return _Expandable(
          icon: Icons.psychology_outlined,
          title: item['durationMs'] is num
              ? L(
                  '思考了 ${spanText(item['durationMs'] as num)}',
                  'Thought for ${spanText(item['durationMs'] as num)}',
                )
              : L('思考', 'Thinking'),
          body: item.text,
        );
      case 'notice':
        return _Notice(item, turn: turn);
      case 'turn_stats':
        return _TurnFooter(item, turn: turn);
      case 'todo':
        return TodoCard(item);
      case 'compaction':
        return _Small(
          item.status == 'running'
              ? L('正在压缩上下文…', 'Compacting context…')
              : L('压缩了上下文', 'Compacted context'),
          icon: Icons.compress,
        );
      default:
        // 没收进过程的单个步骤（只有一步时照原样显示）
        return StepRow(item);
    }
  }
}

/// 你的消息：右侧灰色气泡。faded 是排队中还没发出去的
class UserBubble extends StatelessWidget {
  const UserBubble({
    super.key,
    required this.text,
    this.images = 0,
    this.itemId,
    this.imageMeta = const [],
    this.guidance = false,
    this.faded = false,
    this.onLongPress,
  });
  final String text;

  /// 只知道张数时（排队中的）
  final int images;

  /// 发出去的消息：条目 id 和图片元数据，看得到时向电脑取缩略图
  final String? itemId;
  final List<Json> imageMeta;
  final bool guidance;
  final bool faded;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Align(
      alignment: Alignment.centerRight,
      child: GestureDetector(
        onLongPress: onLongPress,
        child: Container(
          constraints: BoxConstraints(
            maxWidth: MediaQuery.sizeOf(context).width * 0.84,
          ),
          margin: const EdgeInsets.only(top: 10, bottom: 4),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: BoxDecoration(
            color: faded ? c.bgSubtle : c.bgSelected,
            borderRadius: BorderRadius.circular(Radii.bubble),
            border: faded ? Border.all(color: c.borderSubtle) : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (guidance)
                Text(
                  L('插话', 'Steer'),
                  style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                ),
              if (text.isNotEmpty)
                Text(
                  text,
                  style: TextStyle(
                    fontSize: Fs.prose,
                    height: 1.5,
                    color: faded ? c.textSecondary : c.text,
                  ),
                ),
              if (itemId != null && imageMeta.isNotEmpty)
                Padding(
                  padding: EdgeInsets.only(top: text.isEmpty ? 0 : 8),
                  child: ImageStrip(itemId: itemId!, images: imageMeta),
                )
              else if (images > 0)
                ImageCount(images),
            ],
          ),
        ),
      ),
    );
  }
}

class _Small extends StatelessWidget {
  const _Small(this.text, {this.icon});
  final String text;
  final IconData? icon;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          if (icon != null) ...[
            Icon(icon, size: 14, color: c.textFaint),
            const SizedBox(width: 6),
          ],
          Flexible(
            child: Text(
              text,
              style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
            ),
          ),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice(this.item, {required this.turn});
  final Item item;
  final TurnContext turn;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final level = item.level;
    final color = level == 'error'
        ? c.danger
        : level == 'warn'
        ? c.warn
        : c.textMuted;
    final retry = turn.retryId == item.id && turn.onRetry != null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(
                  level == 'error'
                      ? Icons.error_outline
                      : level == 'warn'
                      ? Icons.warning_amber
                      : Icons.info_outline,
                  size: 18,
                  color: color,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  item.text,
                  style: TextStyle(
                    fontSize: Fs.list,
                    height: 1.5,
                    color: color,
                  ),
                ),
              ),
            ],
          ),
          if (retry)
            Padding(
              padding: const EdgeInsets.only(left: 22, top: 6),
              child: OutlinedButton.icon(
                style: OutlinedButton.styleFrom(
                  foregroundColor: c.text,
                  side: BorderSide(color: c.borderCard),
                  shape: const StadiumBorder(),
                  visualDensity: VisualDensity.compact,
                ),
                onPressed: turn.retrying ? null : turn.onRetry,
                icon: turn.retrying
                    ? SizedBox.square(
                        dimension: 14,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.5,
                          color: c.textMuted,
                        ),
                      )
                    : const Icon(Icons.refresh, size: 16),
                label: Text(L('重试', 'Retry')),
              ),
            ),
        ],
      ),
    );
  }
}

/// 一轮结束后回复下面一行：复制、更多 …… 用时 · 步数 · 用量；改了文件再接一张改动卡片
class _TurnFooter extends StatelessWidget {
  const _TurnFooter(this.stats, {required this.turn});
  final Item stats;
  final TurnContext turn;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final items = turn.turns[stats.id] ?? const <Item>[];
    final reply = turn.replies[stats.id];
    final ms = obj(stats['usage'])['durationMs'];
    final steps = stepCount(items);
    final tokens = turnTokens(stats);
    final meta = [
      if (ms is num && ms >= 1000) spanText(ms),
      if (steps > 0) L('$steps 步', steps == 1 ? '1 step' : '$steps steps'),
      if (tokens > 0) '${tokenText(tokens)} tokens',
    ].join(' · ');
    final changes = <String, ({int added, int removed, List<String> diffs})>{};
    for (final i in items) {
      if (i.kind != 'file_change') continue;
      for (final ch in objList(i['changes'])) {
        final path = str(ch['path']) ?? '';
        final old = changes[path];
        changes[path] = (
          added: (old?.added ?? 0) + ((ch['added'] as num?)?.toInt() ?? 0),
          removed:
              (old?.removed ?? 0) + ((ch['removed'] as num?)?.toInt() ?? 0),
          diffs: [...?old?.diffs, ?str(ch['diff'])],
        );
      }
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            if (reply != null && jsTrim(reply).isNotEmpty)
              _FooterIcon(
                icon: Icons.copy_rounded,
                tooltip: L('复制回复', 'Copy reply'),
                onTap: () {
                  Clipboard.setData(ClipboardData(text: reply));
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(SnackBar(content: Text(L('已复制', 'Copied'))));
                },
              ),
            const Spacer(),
            if (meta.isNotEmpty)
              Text(
                meta,
                style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
              ),
          ],
        ),
        if (changes.isNotEmpty) ChangesCard(changes),
        if (turn.review != null) turn.review!(turnKeyOf(items)),
      ],
    );
  }
}

class _FooterIcon extends StatelessWidget {
  const _FooterIcon({
    required this.icon,
    required this.tooltip,
    required this.onTap,
  });
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => IconButton(
    tooltip: tooltip,
    visualDensity: VisualDensity.compact,
    iconSize: 18,
    color: context.colors.textMuted,
    onPressed: onTap,
    icon: Icon(icon),
  );
}

/// 「改动了 N 个文件 +a −r」：每个文件一行，点「查看改动」看 diff
class ChangesCard extends StatelessWidget {
  const ChangesCard(this.changes, {super.key});
  final Map<String, ({int added, int removed, List<String> diffs})> changes;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final added = changes.values.fold(0, (n, x) => n + x.added);
    final removed = changes.values.fold(0, (n, x) => n + x.removed);
    const shown = 4;
    final paths = changes.keys.toList();
    return Container(
      margin: const EdgeInsets.only(top: 6, bottom: 4),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
      decoration: BoxDecoration(
        color: c.bgSurface,
        border: Border.all(color: c.borderCard),
        borderRadius: BorderRadius.circular(Radii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(Icons.difference_outlined, size: 18, color: c.textSecondary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  L(
                    '改动了 ${changes.length} 个文件',
                    '${changes.length} files changed',
                  ),
                  style: TextStyle(
                    fontSize: Fs.list,
                    fontWeight: FontWeight.w600,
                    color: c.text,
                  ),
                ),
              ),
              _Stat(added, removed),
            ],
          ),
          const SizedBox(height: 6),
          for (final p in paths.take(shown))
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  Icon(
                    Icons.insert_drive_file_outlined,
                    size: 16,
                    color: c.textMuted,
                  ),
                  const SizedBox(width: 8),
                  // 文件名和目录一起占满中间，增删行数靠右和标题行对齐
                  Expanded(
                    child: Row(
                      children: [
                        Flexible(
                          child: Text(
                            _base(p),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: Fs.list, color: c.text),
                          ),
                        ),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            p.length > _base(p).length
                                ? p.substring(0, p.length - _base(p).length)
                                : '',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: Fs.meta,
                              color: c.textFaint,
                              fontFamily: 'monospace',
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  _Stat(changes[p]!.added, changes[p]!.removed),
                ],
              ),
            ),
          if (paths.length > shown)
            Text(
              L(
                '还有 ${paths.length - shown} 个文件',
                '${paths.length - shown} more files',
              ),
              style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
            ),
          InkWell(
            onTap: () => showPanel<void>(
              context,
              (_) => _DiffSheet({
                for (final e in changes.entries) e.key: e.value.diffs,
              }),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 10),
              child: Row(
                children: [
                  Text(
                    L('查看改动', 'View changes'),
                    style: TextStyle(
                      fontSize: Fs.list,
                      fontWeight: FontWeight.w500,
                      color: c.accentText,
                    ),
                  ),
                  const Spacer(),
                  Icon(Icons.chevron_right, size: 18, color: c.textFaint),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.added, this.removed);
  final int added;
  final int removed;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '+$added',
            style: TextStyle(color: c.success),
          ),
          const TextSpan(text: ' '),
          TextSpan(
            text: '−$removed',
            style: TextStyle(color: c.danger),
          ),
        ],
      ),
      style: const TextStyle(fontSize: Fs.meta, fontFamily: 'monospace'),
    );
  }
}

class _DiffSheet extends StatelessWidget {
  const _DiffSheet(this.diffs);
  final Map<String, List<String>> diffs;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.85,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
        children: [
          Text(
            L('改动', 'Changes'),
            style: TextStyle(
              fontSize: Fs.section,
              fontWeight: FontWeight.w600,
              color: c.text,
            ),
          ),
          for (final e in diffs.entries) ...[
            Padding(
              padding: const EdgeInsets.only(top: 14, bottom: 6),
              child: Text(
                e.key,
                style: TextStyle(
                  fontSize: Fs.meta,
                  fontFamily: 'monospace',
                  color: c.textMuted,
                ),
              ),
            ),
            for (final d in e.value) DiffView(d),
          ],
        ],
      ),
    );
  }
}

/// 统一 diff：加的行绿底、删的行红底，横向可滚
class DiffView extends StatelessWidget {
  const DiffView(this.diff, {super.key});
  final String diff;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final lines = diff.split('\n');
    final shown = lines.length > 400 ? lines.sublist(0, 400) : lines;
    return Container(
      decoration: BoxDecoration(
        color: c.bgSubtle,
        borderRadius: BorderRadius.circular(10),
      ),
      clipBehavior: Clip.antiAlias,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final l in shown)
                Container(
                  color: l.startsWith('+') && !l.startsWith('+++')
                      ? c.success.withValues(alpha: 0.12)
                      : l.startsWith('-') && !l.startsWith('---')
                      ? c.danger.withValues(alpha: 0.12)
                      : null,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  child: Text(
                    l,
                    style: TextStyle(
                      fontSize: Fs.meta,
                      height: 1.5,
                      fontFamily: 'monospace',
                      color: l.startsWith('@@') ? c.textFaint : c.textSecondary,
                    ),
                  ),
                ),
              if (lines.length > shown.length)
                Padding(
                  padding: const EdgeInsets.all(10),
                  child: Text(
                    L(
                      '太长了，只显示前 400 行',
                      'Too long; showing the first 400 lines',
                    ),
                    style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Expandable extends StatefulWidget {
  const _Expandable({
    required this.icon,
    required this.title,
    required this.body,
  });
  final IconData icon;
  final String title;
  final String body;
  @override
  State<_Expandable> createState() => _ExpandableState();
}

class _ExpandableState extends State<_Expandable> {
  bool _open = false;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: jsTrim(widget.body).isEmpty
                ? null
                : () => setState(() => _open = !_open),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(widget.icon, size: 15, color: c.textMuted),
                const SizedBox(width: 6),
                Text(
                  widget.title,
                  style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                ),
                if (jsTrim(widget.body).isNotEmpty)
                  Icon(
                    _open ? Icons.expand_less : Icons.expand_more,
                    size: 16,
                    color: c.textFaint,
                  ),
              ],
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.only(top: 6, left: 21),
              child: Text(
                widget.body,
                style: TextStyle(
                  fontSize: Fs.list,
                  height: 1.5,
                  color: c.textMuted,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class TodoCard extends StatelessWidget {
  const TodoCard(this.item, {super.key});
  final Item item;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final steps = objList(item['steps']);
    final done = steps.where((s) => s['status'] == 'completed').length;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.bgSurface,
        border: Border.all(color: c.borderCard),
        borderRadius: BorderRadius.circular(Radii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            L('计划 $done / ${steps.length}', 'Plan $done / ${steps.length}'),
            style: TextStyle(
              fontSize: Fs.meta,
              fontWeight: FontWeight.w600,
              color: c.textSecondary,
            ),
          ),
          const SizedBox(height: 6),
          for (final s in steps)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    switch (s['status']) {
                      'completed' => Icons.check_circle,
                      'in_progress' => Icons.radio_button_checked,
                      _ => Icons.radio_button_unchecked,
                    },
                    size: 16,
                    color: s['status'] == 'completed'
                        ? c.success
                        : s['status'] == 'in_progress'
                        ? c.accent
                        : c.textFaint,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      str(s['text']) ?? '',
                      style: TextStyle(
                        fontSize: Fs.list,
                        color: s['status'] == 'completed'
                            ? c.textMuted
                            : c.text,
                        decoration: s['status'] == 'completed'
                            ? TextDecoration.lineThrough
                            : null,
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// 一步一行：图标 · 动作 · 内容；运行中右边转圈，失败图标变红。有输出 / 改动的点开看
class StepRow extends StatelessWidget {
  const StepRow(this.item, {super.key});
  final Item item;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final failed = item.status == 'failed';
    final body = stepBody(item);
    final mono =
        item.kind == 'command' && (str(item['description']) ?? '').isEmpty;
    final shots = item.kind == 'tool'
        ? objList(item['images'])
        : const <Json>[];
    final row = InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: body == null
          ? null
          : () => showPanel<void>(context, (_) => _StepSheet(item)),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Container(
              width: 24,
              height: 24,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: failed ? c.danger.withValues(alpha: 0.1) : c.accentSoft,
                borderRadius: BorderRadius.circular(7),
              ),
              child: Icon(
                stepIcon(item),
                size: 15,
                color: failed ? c.danger : c.accentText,
              ),
            ),
            const SizedBox(width: 10),
            Text(
              stepVerb(item),
              style: TextStyle(fontSize: Fs.list, color: c.textMuted),
            ),
            Text(
              ' · ',
              style: TextStyle(fontSize: Fs.list, color: c.textFaint),
            ),
            Expanded(
              child: Text(
                stepTitle(item),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: mono ? Fs.meta : Fs.list,
                  color: c.textSecondary,
                  fontFamily: mono ? 'monospace' : null,
                ),
              ),
            ),
            if (item.status == 'running')
              Padding(
                padding: const EdgeInsets.only(left: 8),
                child: SizedBox.square(
                  dimension: 12,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.5,
                    color: c.textMuted,
                  ),
                ),
              )
            else if (body != null)
              Icon(Icons.chevron_right, size: 16, color: c.textFaint),
          ],
        ),
      ),
    );
    if (shots.isEmpty) return row;
    // 工具结果里的图（截图、生成的图）：步骤下面一排缩略图
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        row,
        Padding(
          padding: const EdgeInsets.only(left: 34, bottom: 6),
          child: ImageStrip(itemId: item.id, images: shots),
        ),
      ],
    );
  }
}

/// 一步点开能看的：命令和输出、工具输出、改动、思考全文
String? stepBody(Item item) {
  final body = switch (item.kind) {
    'command' => [
      str(item['command']),
      str(item['output']),
    ].whereType<String>().where((s) => s.isNotEmpty).join('\n\n'),
    'tool' => str(item['output']),
    'file_change' => objList(item['changes']).isEmpty ? null : 'diff',
    'reasoning' || 'assistant' => item.text,
    'todo' => [
      for (final s in objList(item['steps']))
        '${s['status'] == 'completed' ? '☑' : '☐'} ${s['text']}',
    ].join('\n'),
    _ => null,
  };
  return body == null || jsTrim(body).isEmpty ? null : body;
}

class _StepSheet extends StatelessWidget {
  const _StepSheet(this.item);
  final Item item;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final body = stepBody(item) ?? '';
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.85,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
        children: [
          Row(
            children: [
              Icon(stepIcon(item), size: 18, color: c.textMuted),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '${stepVerb(item)} · ${stepTitle(item)}',
                  style: TextStyle(
                    fontSize: Fs.prose,
                    fontWeight: FontWeight.w600,
                    color: c.text,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (item.kind == 'file_change')
            for (final ch in objList(item['changes'])) ...[
              Padding(
                padding: const EdgeInsets.only(bottom: 6, top: 6),
                child: Text(
                  str(ch['path']) ?? '',
                  style: TextStyle(
                    fontSize: Fs.meta,
                    fontFamily: 'monospace',
                    color: c.textMuted,
                  ),
                ),
              ),
              DiffView(str(ch['diff']) ?? ''),
            ]
          else
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: c.bgSubtle,
                borderRadius: BorderRadius.circular(10),
              ),
              child: SelectableText(
                body.length > 20000 ? '${body.substring(0, 20000)}\n…' : body,
                style: TextStyle(
                  fontSize: Fs.meta,
                  height: 1.45,
                  fontFamily: 'monospace',
                  color: c.textSecondary,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 过程：运行中一步一行列出来（最多露最近 6 步）、下面是最新的计划和正在写的回复；
/// 做完折成「✓ 已完成 · 摘要 · 用时 ⌄」一行，点开就地展开每一步
class ProcessBlock extends StatefulWidget {
  const ProcessBlock(this.entry, {super.key});
  final ProcessEntry entry;

  @override
  State<ProcessBlock> createState() => _ProcessBlockState();
}

class _ProcessBlockState extends State<ProcessBlock> {
  bool _open = false;
  bool _all = false;
  static const _recent = 6;

  /// 运行中 foldTurns 把正在输出的回复留在过程里（同网页版 ItemView）：
  /// 从后往前跳过思考、信息提示、空白文字，最后是回复就单独显示
  Item? get _streamingReply {
    for (final i in widget.entry.items.reversed) {
      if (i.kind == 'reasoning' ||
          (i.kind == 'notice' && i.level == 'info') ||
          (i.kind == 'assistant' && jsTrim(i.text).isEmpty)) {
        continue;
      }
      return i.kind == 'assistant' ? i : null;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final entry = widget.entry;
    final reply = entry.running ? _streamingReply : null;
    // 列出来的步骤：命令、工具、改文件、思考（有字的）、中途的说明文字；计划单独画
    final steps = [
      for (final i in entry.items)
        if (i.isToolLike ||
            (i.kind == 'reasoning' && jsTrim(i.text).isNotEmpty) ||
            (i.kind == 'assistant' &&
                jsTrim(i.text).isNotEmpty &&
                !identical(i, reply)) ||
            i.kind == 'compaction')
          i,
    ];
    Item? todo;
    for (final i in entry.items.reversed) {
      if (i.kind == 'todo') {
        todo = i;
        break;
      }
    }
    final duration = entry.durationMs;
    if (entry.running) {
      final hidden = _all ? 0 : (steps.length - _recent).clamp(0, 1 << 30);
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (hidden > 0)
              InkWell(
                onTap: () => setState(() => _all = true),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Text(
                    L('前面还有 $hidden 步', '$hidden earlier steps'),
                    style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
                  ),
                ),
              ),
            for (final s in steps.skip(hidden)) _ProcessItem(s),
            if (todo != null) TodoCard(todo),
            if (reply != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: ReplyMarkdown(reply.text),
              ),
          ],
        ),
      );
    }
    final failed = summarizeProcess(entry.items).failed > 0;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  Icon(
                    failed ? Icons.error_outline : Icons.check_circle_outline,
                    size: 17,
                    color: failed ? c.warn : c.textMuted,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      [
                        L('已完成', 'Done'),
                        processSummary(entry.items),
                        if (duration != null && duration >= 1000)
                          spanText(duration),
                      ].join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: Fs.list, color: c.textMuted),
                    ),
                  ),
                  Icon(
                    _open ? Icons.expand_less : Icons.expand_more,
                    size: 20,
                    color: c.textFaint,
                  ),
                ],
              ),
            ),
          ),
          // 折起来时工具结果里的图（截图、生成的图）照样露出来，展开后跟着各自那一步
          if (!_open)
            for (final s in steps)
              if (s.kind == 'tool' && objList(s['images']).isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(left: 25, bottom: 6),
                  child: ImageStrip(itemId: s.id, images: objList(s['images'])),
                ),
          if (_open)
            Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final s in steps) _ProcessItem(s),
                  if (todo != null) TodoCard(todo),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// 过程里的一项：中途的说明文字照常显示成段落（同 DSH Go），其余一步一行
class _ProcessItem extends StatelessWidget {
  const _ProcessItem(this.item);
  final Item item;
  @override
  Widget build(BuildContext context) => item.kind == 'assistant'
      ? Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: ReplyMarkdown(item.text),
        )
      : StepRow(item);
}

/// 调试用：条目原样（JSON）
String debugJson(Object? v) => const JsonEncoder.withIndent('  ').convert(v);

/// 引擎显示名
String engineName(String id) => engines[id]?.name ?? id;
