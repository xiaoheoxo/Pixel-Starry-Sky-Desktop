// B3：长按自己的消息 → 编辑重发（回退到这条，文字放回输入框）→ 撤销（docs/mobile-app.md §14.3）。
// 用演示电脑走真的连接、会话页和长按菜单；演示电脑的回退 / 撤销照电脑上的宿主（截掉之后的条目、能还原）。
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixelsky_app/app/app.dart';
import 'package:pixelsky_app/app/background.dart';
import 'package:pixelsky_app/app/scope.dart';
import 'package:pixelsky_app/app/settings.dart';
import 'package:pixelsky_app/connection/connections.dart';
import 'package:pixelsky_app/connection/pair.dart';
import 'package:pixelsky_app/connection/storage.dart';
import 'package:pixelsky_app/data/desktop_lists.dart';
import 'package:pixelsky_app/data/list_cache.dart';
import 'package:pixelsky_app/demo/demo.dart';
import 'package:pixelsky_app/features/session/items.dart';
import 'package:pixelsky_app/features/session/user_menu.dart';
import 'package:pixelsky_app/i18n/i18n.dart';
import 'package:pixelsky_app/platform/notifier.dart';
import 'package:pixelsky_app/protocol/json.dart';

void main() {
  group('editBlocked：能不能编辑重发', () {
    final user = Item({'kind': 'user', 'id': 'u1', 'text': 'hi'});
    setUp(() => language.value = AppLanguage.zh);
    test('Claude / Codex 空闲时可以', () {
      expect(
        editBlocked(user, engine: 'claude', canAct: true, running: false),
        isNull,
      );
      expect(
        editBlocked(user, engine: 'codex', canAct: true, running: false),
        isNull,
      );
    });
    test('只看、引擎不支持、插话、运行中各给原因', () {
      expect(
        editBlocked(user, engine: 'claude', canAct: false, running: false),
        contains('只看'),
      );
      expect(
        editBlocked(user, engine: 'pixel', canAct: true, running: false),
        contains('不支持'),
      );
      expect(
        editBlocked(
          Item({...user.json, 'mode': 'guidance'}),
          engine: 'codex',
          canAct: true,
          running: false,
        ),
        contains('插话'),
      );
      expect(
        editBlocked(user, engine: 'claude', canAct: true, running: true),
        contains('停止'),
      );
    });
  });

  testWidgets('长按自己的消息 → 编辑重发：回复去掉、文字回到输入框；撤销：回复回来、输入框清空', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);

    final demo = DemoDesktop();
    final connections = Connections(
      store: MemoryPairingStore([demo.pairing]),
      connect: demo.accept,
    );
    await connections.load();
    final settings = AppSettings(persist: false)..language = LanguageChoice.zh;
    final notifier = NoopNotifier();
    final lists = DesktopLists(
      connections,
      cache: ListCache(MemoryCacheStore()),
    );
    await tester.pumpWidget(
      PixelSkyApp(
        services: AppServices(
          connections: connections,
          api: IoBridgeApi(),
          lists: lists,
          settings: settings,
          notifier: notifier,
          watcher: BackgroundWatcher(notifier: notifier, settings: settings),
          demo: true,
        ),
      ),
    );

    Future<void> until(bool Function() ok, String what) async {
      for (var i = 0; i < 100 && !ok(); i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(ok(), isTrue, reason: what);
    }

    // s3：Claude，空闲，一条你的消息 + 一条回复
    final ask = L10n.title3;
    final reply = L10n.reply3.split('\n').first;
    await until(() => find.text(ask).evaluate().isNotEmpty, '连上并拿到列表');
    await tester.tap(find.text(ask).first);
    final bubble = find.descendant(
      of: find.byType(UserBubble),
      matching: find.text(ask),
    );
    // s3 下面还有 PR 条和审查卡：往上滑到这条消息
    await until(
      () =>
          find.byType(UserBubble).evaluate().isNotEmpty ||
          find.text('AI 审查').evaluate().isNotEmpty,
      '打开 s3',
    );
    await tester.dragUntilVisible(
      bubble,
      find.byType(CustomScrollView).last,
      const Offset(0, 300),
    );
    expect(find.textContaining(reply), findsWidgets);

    await tester.longPress(bubble);
    await tester.pump(const Duration(milliseconds: 500));
    await until(() => find.text('编辑重发').evaluate().isNotEmpty, '长按弹出菜单');
    await tester.tap(find.text('编辑重发'));
    await until(
      () => find.text('已回到这条消息，改好再发').evaluate().isNotEmpty,
      '回退后出现撤销条',
    );
    expect(bubble, findsNothing);
    expect(find.textContaining(reply), findsNothing);
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.controller!.text, ask);

    await tester.tap(find.text('撤销'));
    await until(() => find.text('AI 审查').evaluate().isNotEmpty, '撤销后对话回来');
    await tester.dragUntilVisible(
      bubble,
      find.byType(CustomScrollView).last,
      const Offset(0, 300),
    );
    expect(find.textContaining(reply), findsWidgets);
    expect(find.text('已回到这条消息，改好再发'), findsNothing);
    expect(field.controller!.text, '');

    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
