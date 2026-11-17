// 「发到哪个对话」（第三批 D2，docs/mobile-app.md §15.8）：别的 App 分享进来后选一个对话或新建，
// 内容放进那里的输入框（图片进待发），不自动发。多台电脑时上面可以切。
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../data/share.dart';
import '../../data/tasks.dart';
import '../../i18n/i18n.dart';
import '../../ui/session_row.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../new_session/new_session_screen.dart';
import '../session/session_screen.dart';

void openShareTarget(BuildContext context, SharedContent content) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => ShareTargetScreen(content: content),
    ),
  );
}

class ShareTargetScreen extends StatefulWidget {
  const ShareTargetScreen({super.key, required this.content});
  final SharedContent content;

  @override
  State<ShareTargetScreen> createState() => _ShareTargetScreenState();
}

class _ShareTargetScreenState extends State<ShareTargetScreen> {
  String? _device;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final services = AppScope.of(context);
    final pairings = services.connections.pairings;
    final device = pairings.any((p) => p.deviceId == _device)
        ? _device!
        : services.connections.active?.deviceId;
    final content = widget.content;

    void go(String? session) {
      if (device == null) return;
      final nav = Navigator.of(context);
      nav.pop();
      if (session == null) {
        openNewSession(nav.context, device, shared: content);
      } else {
        openSession(nav.context, device, session, shared: content);
      }
    }

    return AppScreen(
      title: L('发到哪个对话', 'Send to which conversation'),
      leading: RoundIconButton(
        icon: Icons.close,
        tooltip: L('取消', 'Cancel'),
        onPressed: () => Navigator.of(context).pop(),
      ),
      body: ListenableBuilder(
        listenable: services.lists,
        builder: (context, _) {
          final data = device == null ? null : services.lists.get(device);
          final list = data == null
              ? const <SessionSummary>[]
              : shareCandidates(data.sessions);
          return ListView(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 32),
            children: [
              _Preview(content),
              if (pairings.length > 1)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final p in pairings)
                        ChoiceChip(
                          label: Text(p.desktopName),
                          selected: p.deviceId == device,
                          onSelected: (_) =>
                              setState(() => _device = p.deviceId),
                        ),
                    ],
                  ),
                ),
              const SizedBox(height: 12),
              Section(
                children: [
                  ListRow(
                    leading: Icon(Icons.edit_square, color: c.textMuted),
                    title: L('新建对话', 'New conversation'),
                    onTap: device == null ? null : () => go(null),
                  ),
                ],
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 16, 8, 6),
                child: Text(
                  L('最近的对话', 'Recent conversations'),
                  style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                ),
              ),
              if (data != null && !data.loaded)
                const Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              else if (list.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    L('还没有对话，新建一个吧', 'No conversations yet — start a new one'),
                    style: TextStyle(fontSize: Fs.ui, color: c.textMuted),
                  ),
                ),
              for (final s in list)
                SessionRow(
                  session: s,
                  projectName: projectNameOf(data!.projects, s.projectId),
                  onTap: () => go(s.id),
                ),
            ],
          );
        },
      ),
    );
  }
}

/// 分享过来的是什么：文字前几行、几张图
class _Preview extends StatelessWidget {
  const _Preview(this.content);
  final SharedContent content;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final n = content.imagePaths.length;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: c.bgSubtle,
        borderRadius: BorderRadius.circular(Radii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            L(
              '放进输入框，不会自动发出',
              'Goes into the message box — not sent automatically',
            ),
            style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
          ),
          if (content.text.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(
              content.text,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: Fs.ui, color: c.text),
            ),
          ],
          if (n > 0) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                Icon(Icons.image_outlined, size: 16, color: c.textMuted),
                const SizedBox(width: 4),
                Text(
                  L('$n 张图片', n == 1 ? '1 image' : '$n images'),
                  style: TextStyle(fontSize: Fs.ui, color: c.text),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
