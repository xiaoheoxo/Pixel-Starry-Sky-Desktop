// App 内更新的提示（docs/mobile-app.md §16.1）：设置页顶上、抽屉底部一条「有新版本」，点开看更新说明、
// 下载（进度条）→ 核对 → 调起系统安装；可以「这版不再提醒」。
import 'package:material_ui/material_ui.dart';

import '../../app/version.dart';
import '../../data/app_update.dart';
import '../../i18n/i18n.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';

/// 有新版本时的一条；没有时什么都不画
class UpdateBanner extends StatelessWidget {
  const UpdateBanner(this.updater, {super.key, this.compact = false});
  final AppUpdater? updater;

  /// 抽屉里：一行字
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final u = updater;
    if (u == null) return const SizedBox.shrink();
    return ListenableBuilder(
      listenable: u,
      builder: (context, _) {
        final r = u.available;
        if (r == null) return const SizedBox.shrink();
        final c = context.colors;
        if (compact) {
          return ListRow(
            title: L('有新版本 ${r.version}', 'Update ${r.version} available'),
            leading: Icon(Icons.system_update_outlined, color: c.accent),
            onTap: () => showUpdate(context, u),
          );
        }
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Material(
            color: c.accentSoft,
            borderRadius: BorderRadius.circular(Radii.card),
            child: InkWell(
              borderRadius: BorderRadius.circular(Radii.card),
              onTap: () => showUpdate(context, u),
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Row(
                  children: [
                    Icon(Icons.system_update_outlined, color: c.accentText),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        L(
                          '有新版本 ${r.version}（现在 $appVersion）',
                          'Version ${r.version} is available (you have $appVersion)',
                        ),
                        style: TextStyle(fontSize: Fs.ui, color: c.accentText),
                      ),
                    ),
                    Icon(Icons.chevron_right, color: c.accentText),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

String _mb(int bytes) => '${(bytes / 1048576).toStringAsFixed(1)} MB';

Future<void> showUpdate(BuildContext context, AppUpdater u) => showPanel<void>(
  context,
  (context) => ListenableBuilder(
    listenable: u,
    builder: (context, _) {
      final c = context.colors;
      final r = u.available;
      if (r == null) return const SizedBox.shrink();
      final busy = u.step == UpdateStep.downloading;
      return SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                L('像素星空 ${r.version}', 'PixelSky ${r.version}'),
                style: TextStyle(
                  fontSize: Fs.section,
                  fontWeight: FontWeight.w600,
                  color: c.text,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                L(
                  '现在是 $appVersion · 安装包 ${_mb(r.size)}',
                  'You have $appVersion · ${_mb(r.size)}',
                ),
                style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
              ),
              if (r.notes.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(
                  r.notes,
                  style: TextStyle(fontSize: Fs.prose, color: c.textBody),
                ),
              ],
              const SizedBox(height: 16),
              if (busy) ...[
                LinearProgressIndicator(value: u.progress),
                const SizedBox(height: 6),
                Text(
                  L(
                    '正在下载 ${(u.progress * 100).round()}%',
                    'Downloading ${(u.progress * 100).round()}%',
                  ),
                  style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                ),
              ],
              if (u.step == UpdateStep.failed)
                Text(
                  u.error == 'sha256'
                      ? L(
                          '下载的文件对不上，没有安装，再试一次',
                          "The download didn't match — not installed. Try again",
                        )
                      : L(
                          '下载失败，检查网络后再试',
                          'Download failed. Check the network and try again',
                        ),
                  style: TextStyle(fontSize: Fs.meta, color: c.danger),
                ),
              if (u.step == UpdateStep.ready)
                Text(
                  L(
                    '已下载。第一次安装要在系统设置里允许「安装未知应用」，允许后回来再点一次',
                    'Downloaded. The first time, allow “Install unknown apps”, then tap again',
                  ),
                  style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                ),
              const SizedBox(height: 12),
              Row(
                children: [
                  TextButton(
                    onPressed: busy
                        ? null
                        : () {
                            u.skip();
                            Navigator.of(context).pop();
                          },
                    child: Text(L('这版不再提醒', 'Skip this version')),
                  ),
                  const Spacer(),
                  FilledButton(
                    onPressed: busy ? null : u.downloadAndInstall,
                    child: Text(
                      u.step == UpdateStep.ready
                          ? L('安装', 'Install')
                          : L('下载并安装', 'Download & install'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
    },
  ),
);
