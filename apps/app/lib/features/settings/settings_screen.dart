// 设置（docs/mobile-app.md §8.2、§8.4）：电脑（切换、在手机上删掉、添加）、通用（外观、语言）、
// 提醒（通知、后台保持连接）、安全（面容 / 指纹锁、电脑和本机指纹）、反馈（问题与建议，有新回复时红点）、页脚版本号。
import 'dart:io';

import 'update_banner.dart';

import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../app/settings.dart';
import '../../app/version.dart';
import '../../connection/connections.dart';
import '../../connection/pair.dart';
import '../../connection/pairing.dart';
import '../../i18n/i18n.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../lock/lock_screen.dart';
import '../feedback/feedback_screen.dart';
import 'log_screen.dart';
import '../pairing/add_computer_screen.dart';
import '../pairing/texts.dart';
import '../session/approval_card.dart' show confirm;

void openSettings(BuildContext context) =>
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => const SettingsScreen()));

String appearanceName(Appearance a) => switch (a) {
  Appearance.system => L('跟随系统', 'System'),
  Appearance.light => L('浅色', 'Light'),
  Appearance.dark => L('深色', 'Dark'),
};

String languageName(LanguageChoice l) => switch (l) {
  LanguageChoice.system => L('跟随系统', 'System'),
  LanguageChoice.zh => '中文',
  LanguageChoice.en => 'English',
};

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen>
    with WidgetsBindingObserver {
  bool? _notify;
  bool? _canLock;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // 从系统设置回来时重新看一次通知权限
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async {
    final s = AppScope.read(context);
    final notify = await s.notifier.enabled().catchError((Object _) => false);
    final canLock = await canAuthenticate();
    if (mounted) {
      setState(() {
        _notify = notify;
        _canLock = canLock;
      });
    }
  }

  /// 底部面板里选一项（外观、语言）
  Future<void> _choose<T>(
    String title,
    List<T> values,
    T current,
    String Function(T) name,
    Future<void> Function(T) set,
  ) async {
    final picked = await showPanel<T>(context, (context) {
      final c = context.colors;
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Section(
          title: title,
          children: [
            for (final v in values)
              ListRow(
                title: name(v),
                trailing: v == current
                    ? Icon(Icons.check, color: c.accent)
                    : const SizedBox(),
                onTap: () => Navigator.of(context).pop(v),
              ),
          ],
        ),
      );
    });
    if (picked != null && picked != current) await set(picked);
  }

  /// 在手机上删掉一台电脑：电脑那边的记录要在电脑上移除
  Future<void> _forget(Pairing p) async {
    final s = AppScope.read(context);
    final ok = await confirm(
      context,
      L(
        '在这部手机上删掉「${p.desktopName}」？\n删掉后要重新扫码才能再连。电脑那边请在「设置 › 手机」里把这部手机也移除。',
        'Remove “${p.desktopName}” from this phone?\nYou’ll need to scan again to reconnect. On the computer, also remove this phone under Settings › Phone.',
      ),
      ok: L('删掉', 'Remove'),
    );
    if (!ok || !mounted) return;
    await s.connections.forget(p.deviceId);
    await s.settings.forgetDevice(p.deviceId);
    // 删光了：回到最开始，根页面会换成「添加电脑」
    if (mounted && s.connections.pairings.isEmpty) {
      Navigator.of(context).popUntil((r) => r.isFirst);
    }
  }

  void _computerMenu(Pairing p) {
    showPanel<void>(context, (context) {
      final c = context.colors;
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Section(
          title: p.desktopName,
          children: [
            ListRow(
              title: L('在手机上删掉', 'Remove from this phone'),
              danger: true,
              leading: Icon(Icons.delete_outline, color: c.danger),
              onTap: () {
                Navigator.of(context).pop();
                _forget(p);
              },
            ),
          ],
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = AppScope.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([s.settings, s.connections, ?s.feedback]),
      builder: (context, _) {
        final active = s.connections.active;
        return AppScreen(
          title: L('设置', 'Settings'),
          leading: RoundIconButton(
            icon: Icons.arrow_back,
            tooltip: L('返回', 'Back'),
            onPressed: () => Navigator.of(context).pop(),
          ),
          body: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            children: [
              // 有新版本（§16.1）
              UpdateBanner(s.updater),
              Section(
                title: L('电脑', 'Computers'),
                children: [
                  for (final p in s.connections.pairings)
                    _ComputerRow(
                      pairing: p,
                      connections: s.connections,
                      current: p.deviceId == active?.deviceId,
                      onMenu: () => _computerMenu(p),
                    ),
                  ListRow(
                    title: L('添加电脑', 'Add computer'),
                    leading: Icon(Icons.add_circle_outline, color: c.textMuted),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const AddComputerScreen(canClose: true),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Section(
                title: L('通用', 'General'),
                children: [
                  ListRow(
                    title: L('外观', 'Appearance'),
                    subtitle: appearanceName(s.settings.appearance),
                    leading: Icon(Icons.contrast, color: c.textMuted),
                    onTap: () => _choose(
                      L('外观', 'Appearance'),
                      Appearance.values,
                      s.settings.appearance,
                      appearanceName,
                      s.settings.setAppearance,
                    ),
                  ),
                  ListRow(
                    title: L('语言', 'Language'),
                    subtitle: languageName(s.settings.language),
                    leading: Icon(Icons.translate, color: c.textMuted),
                    onTap: () => _choose(
                      L('语言', 'Language'),
                      LanguageChoice.values,
                      s.settings.language,
                      languageName,
                      s.settings.setLanguage,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Section(
                title: L('提醒', 'Alerts'),
                children: [
                  ListRow(
                    leading: Icon(
                      Icons.notifications_outlined,
                      color: c.textMuted,
                    ),
                    title: L('通知', 'Notifications'),
                    subtitle: _notify == null
                        ? null
                        : _notify!
                        ? L(
                            '已允许：任务等你处理、完成、出错时提醒',
                            'On: alerts when a task needs you, finishes, or fails',
                          )
                        : L('没有允许，点这里打开', 'Off. Tap to allow'),
                    trailing: _notify == true
                        ? Icon(Icons.check, color: c.statusOnline)
                        : null,
                    onTap: _notify == true
                        ? null
                        : () async {
                            await s.notifier.requestPermission();
                            _refresh();
                          },
                  ),
                  if (Platform.isAndroid)
                    SwitchListTile(
                      value: s.settings.keepAlive,
                      onChanged: s.settings.setKeepAlive,
                      title: Text(
                        L('切到后台时保持连接', 'Stay connected in the background'),
                        style: TextStyle(fontSize: Fs.prose, color: c.text),
                      ),
                      subtitle: Text(
                        L(
                          '通知栏会常驻一条「已连上」。关掉后切到后台一会儿就断开，收不到提醒',
                          'Shows an ongoing “Connected” notification. When off, the connection drops soon after you leave and alerts stop.',
                        ),
                        style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 8),
              Section(
                title: L('安全', 'Security'),
                children: [
                  SwitchListTile(
                    value: s.settings.lock,
                    onChanged: _canLock != true
                        ? null
                        : (v) async {
                            // 打开、关掉都先验证一次，免得别人拿着手机改掉
                            final ok = await authenticate(
                              v
                                  ? L('打开面容 / 指纹锁', 'Turn on app lock')
                                  : L('关掉面容 / 指纹锁', 'Turn off app lock'),
                            );
                            if (ok) await s.settings.setLock(v);
                          },
                    title: Text(
                      L('面容 / 指纹锁', 'App lock'),
                      style: TextStyle(fontSize: Fs.prose, color: c.text),
                    ),
                    subtitle: Text(
                      _canLock == false
                          ? L(
                              '这台手机没有设锁屏密码，开不了',
                              'Set a screen lock on this phone first',
                            )
                          : L(
                              '打开 App、离开超过 1 分钟回来时先验证',
                              'Verify when opening the app or returning after 1 minute',
                            ),
                      style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                    ),
                  ),
                  if (active != null) ...[
                    ListRow(
                      title: L(
                        '「${active.desktopName}」的指纹',
                        '“${active.desktopName}” fingerprint',
                      ),
                      subtitle: active.fingerprint,
                      leading: Icon(Icons.computer, color: c.textMuted),
                    ),
                    ListRow(
                      title: L('这部手机的指纹', 'This phone’s fingerprint'),
                      subtitle: phoneFingerprint(active),
                      leading: Icon(Icons.smartphone, color: c.textMuted),
                    ),
                  ],
                ],
              ),
              if (active != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
                  child: Text(
                    L(
                      '和电脑「设置 › 手机」里显示的一致，说明连的是自己的电脑。',
                      'Should match what the computer shows under Settings › Phone.',
                    ),
                    style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                  ),
                ),
              const SizedBox(height: 8),
              Section(
                title: L('反馈', 'Feedback'),
                children: [
                  if (active != null)
                    ListRow(
                      leading: Icon(
                        Icons.chat_bubble_outline,
                        color: c.textMuted,
                      ),
                      title: L('问题与建议', 'Problems & suggestions'),
                      subtitle: L(
                        '经「${active.desktopName}」发给团队',
                        'To the team via “${active.desktopName}”',
                      ),
                      trailing: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if ((s.feedback?.unread(active.deviceId) ?? 0) > 0)
                            Container(
                              width: 8,
                              height: 8,
                              margin: const EdgeInsets.only(right: 8),
                              decoration: BoxDecoration(
                                color: c.notify,
                                shape: BoxShape.circle,
                              ),
                            ),
                          Icon(Icons.chevron_right, color: c.textFaint),
                        ],
                      ),
                      onTap: () => openFeedback(context, active.deviceId),
                    ),
                  // 手机日志（§19）：没配对也能看（配对失败也记在这里）
                  ListRow(
                    leading: Icon(
                      Icons.receipt_long_outlined,
                      color: c.textMuted,
                    ),
                    title: L('日志', 'Log'),
                    subtitle: L(
                      '连接、调用失败和报错，出问题时看这里',
                      'Connection, failed calls and errors',
                    ),
                    onTap: () => openLogs(context),
                  ),
                ],
              ),
              Padding(
                padding: const EdgeInsets.only(top: 28),
                child: Text(
                  L('像素星空 $appVersion', 'PixelSky $appVersion'),
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// 一台配对过的电脑：点了切换过去，右边「⋯」删掉
class _ComputerRow extends StatelessWidget {
  const _ComputerRow({
    required this.pairing,
    required this.connections,
    required this.current,
    required this.onMenu,
  });
  final Pairing pairing;
  final Connections connections;
  final bool current;
  final VoidCallback onMenu;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListRow(
      title: pairing.desktopName,
      subtitle:
          linkStateText(connections.state(pairing.deviceId)) ??
          L('已连接', 'Connected'),
      leading: Icon(Icons.computer, color: c.textMuted),
      onTap: current ? null : () => connections.select(pairing.deviceId),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (current) Icon(Icons.check, color: c.accent),
          IconButton(
            tooltip: L('更多', 'More'),
            icon: Icon(Icons.more_horiz, color: c.textMuted),
            onPressed: onMenu,
          ),
        ],
      ),
    );
  }
}
