// 会话菜单（规则照网页版 SessionMenu.tsx）：重命名、置顶 / 取消置顶、在这个项目里新建对话、归档（红字）。
// 会话页点标题胶囊打开，抽屉里长按会话行打开。归档前确认；在运行的问要不要停止并归档。
// 出错时用底部提示条说（面板已经关了）。
import 'package:material_ui/material_ui.dart';

import '../../data/actions.dart';
import '../../data/tools.dart' show ToolId;
import '../../i18n/i18n.dart';
import '../../protocol/constants.dart';
import '../../protocol/json.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../tools/tools.dart' show ToolTile;
import 'approval_card.dart' show confirm;
import '../settings/log_screen.dart' show showErrorSnack;

/// record：会话记录（id、title、pinnedAt、projectId）；running：是否在跑
Future<void> showSessionMenu(
  BuildContext context, {
  required Json record,
  required SessionActions actions,
  required bool running,
  void Function(String projectId)? onNew,
  VoidCallback? onArchived,

  /// 第一排 Git / 文件 / 产物 / 任务（作用于这个会话的项目；对话类会话没有）
  void Function(ToolId tool)? onTool,

  /// 旁聊（docs/mobile-app.md §15.3）；sideChatOff 是用不了的原因（引擎不支持），有原因时灰掉
  VoidCallback? onSideChat,
  String? sideChatOff,
}) async {
  final canAct = actions.canAct;
  final pinned = record['pinnedAt'] != null;
  final projectId = str(record['projectId']);
  final title = str(record['title']) ?? '';
  final pick = await showPanel<String>(
    context,
    (context) => SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 12),
              child: Text(
                title.trim().isEmpty
                    ? L('未命名会话', 'Untitled conversation')
                    : title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: Fs.section,
                  fontWeight: FontWeight.w600,
                  color: context.colors.text,
                ),
              ),
            ),
            if (onTool != null) ...[
              Row(
                children: [
                  for (final id in ToolId.values) ...[
                    if (id != ToolId.git) const SizedBox(width: 8),
                    Expanded(
                      child: ToolTile(
                        id: id,
                        onTap: () => Navigator.pop(context, 'tool:${id.name}'),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 12),
            ],
            Section(
              children: [
                ListRow(
                  leading: const Icon(Icons.edit_outlined),
                  title: L('重命名', 'Rename'),
                  trailing: const SizedBox(),
                  onTap: canAct ? () => Navigator.pop(context, 'rename') : null,
                ),
                ListRow(
                  leading: Icon(
                    pinned ? Icons.push_pin_outlined : Icons.push_pin,
                  ),
                  title: pinned ? L('取消置顶', 'Unpin') : L('置顶', 'Pin'),
                  trailing: const SizedBox(),
                  onTap: canAct ? () => Navigator.pop(context, 'pin') : null,
                ),
                if (onSideChat != null)
                  ListRow(
                    leading: const Icon(Icons.forum_outlined),
                    title: L('旁聊', 'Side chat'),
                    subtitle:
                        sideChatOff ??
                        L(
                          '问一句，不打断正在跑的这一轮',
                          "Ask without interrupting the current turn",
                        ),
                    trailing: const SizedBox(),
                    onTap: canAct && sideChatOff == null
                        ? () => Navigator.pop(context, 'side')
                        : null,
                  ),
                if (onNew != null &&
                    projectId != null &&
                    projectId != chatProjectId)
                  ListRow(
                    leading: const Icon(Icons.add_comment_outlined),
                    title: L('在这个项目里新建对话', 'New conversation in this project'),
                    trailing: const SizedBox(),
                    onTap: canAct ? () => Navigator.pop(context, 'new') : null,
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Section(
              children: [
                ListRow(
                  leading: Icon(
                    Icons.archive_outlined,
                    color: context.colors.danger,
                  ),
                  title: L('归档', 'Archive'),
                  danger: true,
                  trailing: const SizedBox(),
                  onTap: canAct
                      ? () => Navigator.pop(context, 'archive')
                      : null,
                ),
              ],
            ),
            if (!canAct)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(
                  L(
                    '没连上电脑，或这部手机是「只看」。',
                    'Not connected, or this phone is “View only”.',
                  ),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: Fs.meta,
                    color: context.colors.textMuted,
                  ),
                ),
              ),
          ],
        ),
      ),
    ),
  );
  if (!context.mounted || pick == null) return;
  if (pick.startsWith('tool:')) {
    onTool?.call(ToolId.values.byName(pick.substring(5)));
    return;
  }
  switch (pick) {
    case 'rename':
      await showPanel<void>(
        context,
        (_) => _RenameSheet(title: title, actions: actions),
      );
    case 'pin':
      try {
        await actions.pin(!pinned);
      } catch (e) {
        if (context.mounted) showErrorSnack(context, actionError(e));
      }
    case 'new':
      onNew?.call(projectId!);
    case 'side':
      onSideChat?.call();
    case 'archive':
      await archiveSession(
        context,
        actions: actions,
        running: running,
        onArchived: onArchived,
      );
  }
}

/// 归档：在跑的问要不要停止并归档；手机上看着没在跑、电脑上其实在跑的，电脑回 SESSION_RUNNING 后再问一次
Future<void> archiveSession(
  BuildContext context, {
  required SessionActions actions,
  required bool running,
  VoidCallback? onArchived,
}) async {
  final ok = await confirm(
    context,
    running
        ? L(
            '这个会话还在运行。停止并归档？',
            'This conversation is still running. Stop and archive it?',
          )
        : L(
            '归档这个会话？以后可以在电脑上找回。',
            'Archive this conversation? You can restore it on the computer later.',
          ),
    ok: L('归档', 'Archive'),
  );
  if (!ok) return;
  try {
    await actions.archive(stop: running);
    onArchived?.call();
  } catch (e) {
    if ('$e' == 'SESSION_RUNNING' && context.mounted) {
      final stop = await confirm(
        context,
        L(
          '电脑上这个会话还在运行。停止并归档？',
          'This conversation is still running on the computer. Stop and archive it?',
        ),
        ok: L('归档', 'Archive'),
      );
      if (!stop) return;
      try {
        await actions.archive(stop: true);
        onArchived?.call();
      } catch (e) {
        if (context.mounted) showErrorSnack(context, actionError(e));
      }
    } else if (context.mounted) {
      showErrorSnack(context, actionError(e));
    }
  }
}

class _RenameSheet extends StatefulWidget {
  const _RenameSheet({required this.title, required this.actions});
  final String title;
  final SessionActions actions;
  @override
  State<_RenameSheet> createState() => _RenameSheetState();
}

class _RenameSheetState extends State<_RenameSheet> {
  late final _text = TextEditingController(text: widget.title);
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final clean = _text.text.trim();
    if (clean.isEmpty || clean == widget.title || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.actions.rename(clean);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = '$e' == 'MOBILE_BAD_ARGUMENT'
              ? L('电脑不接受这个名字。', "The computer didn't accept this name.")
              : actionError(e),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final clean = _text.text.trim();
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              L('重命名', 'Rename'),
              style: TextStyle(
                fontSize: Fs.section,
                fontWeight: FontWeight.w600,
                color: c.text,
              ),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _text,
              autofocus: true,
              maxLength: 200,
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _save(),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  _error!,
                  style: TextStyle(fontSize: Fs.meta, color: c.danger),
                ),
              ),
            PrimaryButton(
              label: L('保存', 'Save'),
              busy: _busy,
              onPressed: clean.isEmpty || clean == widget.title ? null : _save,
            ),
          ],
        ),
      ),
    );
  }
}
