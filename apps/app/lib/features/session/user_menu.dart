// 长按自己的消息：编辑重发（回退到这条，文字放回输入框）和复制；回退之后输入框上面一条「撤销」
// （docs/mobile-app.md §14.3）。手机上只回退对话，电脑上的文件不动。
import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../i18n/i18n.dart';
import '../../protocol/constants.dart';
import '../../protocol/json.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';

/// 这条消息能不能编辑重发；不能时给一句原因（菜单里灰掉那一项并写在下面）
String? editBlocked(
  Item item, {
  required String engine,
  required bool canAct,
  required bool running,
}) {
  if (!canAct) {
    return L('这部手机是「只看」', 'This phone is set to “View only”');
  }
  if (engines[engine]?.rewind != true) {
    return L('这个引擎不支持回退', "This engine can't go back");
  }
  if (item.mode == 'guidance') {
    return L('插话不能编辑', "Steering messages can't be edited");
  }
  if (running) return L('先停止当前任务', 'Stop the current task first');
  return null;
}

/// 弹出菜单，返回选的那项：'edit' / 'copy'，或 null
Future<String?> showUserMessageMenu(
  BuildContext context, {
  required Item item,
  required String? blocked,
}) => showPanel<String>(
  context,
  (context) => SafeArea(
    top: false,
    child: Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Section(
        children: [
          ListRow(
            leading: const Icon(Icons.edit_outlined),
            title: L('编辑重发', 'Edit and resend'),
            subtitle:
                blocked ??
                L(
                  '回到这条消息，之后的对话会去掉；电脑上的文件不动',
                  'Go back to this message and drop what came after. Files on the computer stay as they are.',
                ),
            trailing: const SizedBox(),
            onTap: blocked == null
                ? () => Navigator.pop(context, 'edit')
                : null,
          ),
          if (item.text.isNotEmpty)
            ListRow(
              leading: const Icon(Icons.copy_outlined),
              title: L('复制', 'Copy'),
              trailing: const SizedBox(),
              onTap: () => Navigator.pop(context, 'copy'),
            ),
        ],
      ),
    ),
  ),
);

Future<void> copyMessage(Item item) =>
    Clipboard.setData(ClipboardData(text: item.text));

/// 回退之后输入框上面的一条：「已回到这条消息」+ 撤销
class RewindBar extends StatelessWidget {
  const RewindBar({super.key, required this.onUndo, required this.busy});
  final VoidCallback onUndo;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 0),
      padding: const EdgeInsets.only(left: 14, right: 4),
      decoration: BoxDecoration(
        color: c.bgSubtle,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Icon(Icons.undo, size: 16, color: c.textMuted),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              L('已回到这条消息，改好再发', 'Back at this message. Edit and send.'),
              style: TextStyle(fontSize: Fs.meta, color: c.textSecondary),
            ),
          ),
          TextButton(
            onPressed: busy ? null : onUndo,
            child: Text(L('撤销', 'Undo')),
          ),
        ],
      ),
    );
  }
}
