// 像素星空手机 App 入口（docs/mobile-app.md）：读出配对过的电脑并连上，没有就先去配对
import 'package:material_ui/material_ui.dart';

import 'package:app_links/app_links.dart';

import 'app/app.dart';
import 'app/background.dart';
import 'app/settings.dart';
import 'app/scope.dart';
import 'connection/connections.dart';
import 'connection/pair.dart';
import 'connection/socket.dart';
import 'connection/storage.dart';
import 'data/desktop_lists.dart';
import 'data/feedback.dart';
import 'data/list_cache.dart';
import 'demo/demo.dart';
import 'i18n/i18n.dart';
import 'platform/notifier.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  language.value = languageFor(
    WidgetsBinding.instance.platformDispatcher.locale,
  );
  // 演示模式（--dart-define=DEMO=1）：App 里起一台假电脑，不读也不写本机的配对
  final demo = demoEnabled ? DemoDesktop() : null;
  final connections = demo != null
      ? Connections(
          store: MemoryPairingStore([demo.pairing]),
          connect: demo.accept,
        )
      : Connections(store: SecurePairingStore(), connect: connectRelay);
  // 演示模式不写本机：设置和列表缓存都只放内存
  final settings = AppSettings(persist: demo == null);
  final notifier = LocalNotifier();
  await Future.wait([connections.load(), settings.load()]);
  runApp(
    PixelSkyApp(
      links: AppLinks(),
      services: AppServices(
        connections: connections,
        api: IoBridgeApi(),
        lists: DesktopLists(
          connections,
          cache: ListCache(
            demo == null ? PrefsCacheStore() : MemoryCacheStore(),
          ),
        ),
        settings: settings,
        notifier: notifier,
        watcher: BackgroundWatcher(notifier: notifier, settings: settings),
        feedback: FeedbackUnread(connections),
        demo: demo != null,
      ),
    ),
  );
}
