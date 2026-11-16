// 会话列表的一行（抽屉、概览共用）：引擎头像 + 标题 + 时间；第二行状态点 + 状态或「引擎 · 最后一句」
import 'package:material_ui/material_ui.dart';

import '../data/tasks.dart';
import '../protocol/codex_directives.dart';
import '../protocol/constants.dart';
import 'theme/tokens.dart';
import 'theme/type.dart';

class EngineAvatar extends StatelessWidget {
  const EngineAvatar(this.engine, {super.key, this.size = 32});
  final String engine;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final short = engines[engine]?.short ?? '?';
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: engine == 'claude'
            ? c.engineClaude.withValues(alpha: 0.15)
            : c.bgSubtle,
        shape: BoxShape.circle,
      ),
      child: Text(
        short,
        style: TextStyle(
          fontSize: size >= 32 ? Fs.meta : Fs.label,
          fontWeight: FontWeight.w600,
          color: engine == 'claude' ? c.engineClaude : c.textSecondary,
        ),
      ),
    );
  }
}

class SessionRow extends StatelessWidget {
  const SessionRow({
    super.key,
    required this.session,
    required this.onTap,
    this.onLongPress,
    this.selected = false,
    this.projectName,
  });
  final SessionSummary session;
  final VoidCallback onTap;

  /// 长按：会话菜单（抽屉里）
  final VoidCallback? onLongPress;
  final bool selected;

  /// 「最近」里显示项目名；按项目分组时不显示
  final String? projectName;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final status = sessionStatus(session);
    final reply = session.lastReply == null
        ? ''
        : codexPlainText(session.lastReply!);
    final second =
        status?.text ??
        [
          engines[session.engine]?.name ?? session.engine,
          if (projectName != null && projectName!.isNotEmpty) projectName!,
          if (reply.isNotEmpty) reply.replaceAll(RegExp(r'\s+'), ' '),
        ].join(' · ');
    final dot = switch (status?.tone) {
      Tone.danger => c.notify,
      Tone.online => c.statusOnline,
      Tone.warn => c.warn,
      null => null,
    };
    return Material(
      color: selected ? c.bgSelected : Colors.transparent,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        onLongPress: onLongPress,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          child: Row(
            children: [
              EngineAvatar(session.engine),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        if (session.pinned) ...[
                          Icon(Icons.push_pin, size: 12, color: c.textMuted),
                          const SizedBox(width: 4),
                        ],
                        Expanded(
                          child: Text(
                            taskTitle(session),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: Fs.ui,
                              fontWeight: FontWeight.w500,
                              color: c.text,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          ago(session.updatedAt),
                          style: TextStyle(
                            fontSize: Fs.meta,
                            color: c.textFaint,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Row(
                      children: [
                        if (dot != null) ...[
                          Container(
                            width: 7,
                            height: 7,
                            decoration: BoxDecoration(
                              color: dot,
                              shape: BoxShape.circle,
                            ),
                          ),
                          const SizedBox(width: 6),
                        ],
                        Expanded(
                          child: Text(
                            second,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: Fs.meta,
                              color: status?.tone == Tone.danger
                                  ? c.notify
                                  : c.textMuted,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
