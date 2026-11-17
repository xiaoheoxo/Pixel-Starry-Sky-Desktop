// D2：从别的 App 分享进对话（docs/mobile-app.md §15.8）。合成规则、列出的会话；
// 演示电脑走一遍：分享进来 → 「发到哪个对话」→ 选一个 → 字放进输入框，没有发出去。
import 'dart:async';

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
import 'package:pixelsky_app/data/share.dart';
import 'package:pixelsky_app/data/tasks.dart';
import 'package:pixelsky_app/demo/demo.dart';
import 'package:pixelsky_app/platform/notifier.dart';
import 'package:pixelsky_app/platform/share_inbox.dart';

class FakeShareInbox implements ShareInbox {
  final _c = StreamController<SharedContent>.broadcast();
  void push(SharedContent c) => _c.add(c);
  @override
  Future<SharedContent?> initial() async => null;
  @override
  Stream<SharedContent> get received => _c.stream;
}

SessionSummary _s(String id, String state, num at, {bool pinned = false}) =>
    SessionSummary({
      'record': {
        'id': id,
        'projectId': 'p',
        'title': id,
        'updatedAt': at,
        if (pinned) 'pinned': true,
      },
      'state': state,
    });

void main() {
  test('文字和链接拼成一段、去重；图片按路径；视频和文件不收', () {
    final c = sharedContent([
      (type: 'text', path: '看看这个报错'),
      (type: 'url', path: 'https://example.com/a'),
      (type: 'url', path: 'https://example.com/a'),
      (type: 'image', path: '/tmp/a.png'),
      (type: 'video', path: '/tmp/v.mp4'),
      (type: 'file', path: '/tmp/x.zip'),
      (type: 'text', path: '  '),
    ]);
    expect(c.text, '看看这个报错\nhttps://example.com/a');
    expect(c.imagePaths, ['/tmp/a.png']);
    expect(sharedContent([(type: 'video', path: '/v')]).isEmpty, isTrue);
  });

  test('列出的会话：等你处理的在前，最多 8 个', () {
    final list = shareCandidates([
      for (var i = 0; i < 12; i++) _s('r$i', 'idle', i),
      _s('w', 'waiting', 0),
    ]);
    expect(list.length, 8);
    expect(list.first.id, 'w');
    expect(list[1].id, 'r11');
  });

  testWidgets('分享进来选一个对话：字放进输入框，不自动发', (tester) async {
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
    final share = FakeShareInbox();
    await tester.pumpWidget(
      PixelSkyApp(
        services: AppServices(
          connections: connections,
          api: IoBridgeApi(),
          lists: lists,
          settings: settings,
          notifier: notifier,
          watcher: BackgroundWatcher(notifier: notifier, settings: settings),
          share: share,
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

    await until(() => find.text(L10n.title3).evaluate().isNotEmpty, '连上并拿到列表');
    share.push(const SharedContent(text: '帮我看看 https://example.com/err'));
    await until(() => find.text('发到哪个对话').evaluate().isNotEmpty, '打开选对话页');
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('新建对话'), findsOneWidget);
    await tester.tap(find.text(L10n.title3).last);
    await until(
      () => find.byIcon(Icons.auto_awesome).evaluate().isNotEmpty,
      '打开会话',
    );
    final field = tester.widget<TextField>(find.byType(TextField).last);
    expect(field.controller!.text, '帮我看看 https://example.com/err');

    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
