// 根组件：外观、语言按设置（默认跟随系统，A4）；没有配对过的电脑时先去配对。
// A3：前后台切换时告诉连接和后台提醒（安卓起前台服务保持连接）；点通知 / pixelsky:// 链接打开对应页面；
// 开了面容 / 指纹锁时，打开 App 和离开超过 1 分钟回来先验证。
import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:material_ui/material_ui.dart';

import '../data/notify.dart';
import '../features/home/home_screen.dart';
import '../features/lock/lock_screen.dart';
import '../features/pairing/add_computer_screen.dart';
import '../features/session/session_screen.dart';
import '../i18n/i18n.dart';
import '../ui/theme/theme.dart';
import '../ui/theme/type.dart';
import 'background.dart';
import 'scope.dart';
import 'settings.dart';

class PixelSkyApp extends StatefulWidget {
  const PixelSkyApp({super.key, required this.services, this.links});
  final AppServices services;

  /// pixelsky:// 链接（测试里不传）
  final AppLinks? links;

  @override
  State<PixelSkyApp> createState() => _PixelSkyAppState();
}

class _PixelSkyAppState extends State<PixelSkyApp> with WidgetsBindingObserver {
  final _navigator = GlobalKey<NavigatorState>();
  final _messenger = GlobalKey<ScaffoldMessengerState>();
  final _subs = <StreamSubscription<Object?>>[];

  /// 面容 / 指纹锁：现在锁着；什么时候切到后台的
  late bool _locked = widget.services.settings.lock;
  DateTime? _leftAt;
  static const _relockAfter = Duration(minutes: 1);

  AppServices get _s => widget.services;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _s.watcher.attach(_s.connections, _s.lists);
    _s.settings.addListener(_applyLanguage);
    _applyLanguage();
    _subs.add(_s.notifier.taps.listen(_openTarget));
    final links = widget.links;
    if (links != null) _subs.add(links.uriLinkStream.listen(_openLink));
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final target = await _s.notifier.launchTarget();
      if (target != null) {
        _openTarget(target);
      } else {
        final uri = await links?.getInitialLink();
        if (uri != null) _openLink(uri);
      }
      // 配过电脑才要通知权限（安卓 13+ 弹一次，之前选过就不再问）
      if (_s.connections.pairings.isNotEmpty) {
        _s.notifier.requestPermission().catchError((Object _) => false);
      }
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _s.settings.removeListener(_applyLanguage);
    for (final s in _subs) {
      s.cancel();
    }
    super.dispose();
  }

  /// 语言：设置里选的，或跟随系统；变了就把已经建好的页面全部重建一遍（文字是 L() 直接取的，不会自己更新）
  void _applyLanguage() {
    final next = resolveLanguage(
      _s.settings.language,
      WidgetsBinding.instance.platformDispatcher.locale,
    );
    if (language.value == next) return;
    language.value = next;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      void walk(Element e) {
        e.markNeedsBuild();
        e.visitChildren(walk);
      }

      (context as Element).visitChildren(walk);
    });
  }

  @override
  void didChangeLocales(List<Locale>? locales) => _applyLanguage();

  /// 切到后台 / 回到前台：告诉电脑（后台时它照样推送提醒），回到前台马上重连或探一下
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final foreground = state == AppLifecycleState.resumed;
    _s.connections.setForeground(foreground);
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _leftAt ??= DateTime.now();
      _s.lists.flushCache();
      _s.watcher.setForeground(
        false,
        keepAliveText: _s.connections.pairings.isEmpty
            ? null
            : keepAliveText(_s.connections),
      );
    } else if (foreground) {
      _s.watcher.setForeground(true);
      final left = _leftAt;
      _leftAt = null;
      if (_s.settings.lock &&
          left != null &&
          DateTime.now().difference(left) >= _relockAfter) {
        setState(() => _locked = true);
      }
    }
  }

  /// 点了通知：只涉及一个会话就打开它；「等你处理」涉及几个时逐个处理
  Future<void> _openTarget(NotifyTarget t) async {
    final c = _s.connections;
    if (!c.pairings.any((p) => p.deviceId == t.device)) return;
    if (c.active?.deviceId != t.device) await c.select(t.device);
    final nav = _navigator.currentState;
    final ctx = _navigator.currentContext;
    if (nav == null || ctx == null || !ctx.mounted) return;
    nav.popUntil((r) => r.isFirst);
    if (t.session != null) {
      openSession(ctx, t.device, t.session!, notified: t.waiting);
      return;
    }
    if (!t.waiting) return;
    final triage = Triage.start(_s.lists.get(t.device).sessions);
    if (triage == null) {
      _messenger.currentState?.showSnackBar(
        SnackBar(
          content: Text(L('已经在电脑上处理了', 'Already handled on the computer')),
        ),
      );
      return;
    }
    openSession(ctx, t.device, triage.ids.first, triage: triage);
  }

  /// pixelsky:// 链接：配对
  void _openLink(Uri uri) {
    final ctx = _navigator.currentContext;
    if (ctx == null || !ctx.mounted) return;
    openOffer(ctx, uri.toString());
  }

  @override
  Widget build(BuildContext context) {
    return AppScope(
      services: _s,
      child: ListenableBuilder(
        listenable: Listenable.merge([language, _s.settings]),
        builder: (context, _) => MaterialApp(
          title: L('像素星空', 'PixelSky'),
          debugShowCheckedModeBanner: false,
          navigatorKey: _navigator,
          scaffoldMessengerKey: _messenger,
          theme: buildTheme(Brightness.light),
          darkTheme: buildTheme(Brightness.dark),
          themeMode: themeModeFor(_s.settings.appearance),
          home: const _Root(),
          // 系统字体最多放大 1.3 倍；锁着时盖在所有页面上面（页面状态留着，解锁后接着用）
          builder: (context, child) => clampTextScale(
            context,
            Stack(
              children: [
                ?child,
                if (_locked)
                  Positioned.fill(
                    child: LockScreen(
                      onUnlocked: () => setState(() => _locked = false),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Root extends StatelessWidget {
  const _Root();

  @override
  Widget build(BuildContext context) {
    final connections = AppScope.of(context).connections;
    return connections.pairings.isEmpty
        ? const AddComputerScreen()
        : const HomeScreen();
  }
}
