// 消息里的图片（docs/mobile-app.md §15.16）：演示电脑「周报润色」里一条带图的消息和一张工具截图，
// 看到时向电脑取缩略图，点开全屏看、能存相册；取不到时显示原因。
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_svg/flutter_svg.dart';
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
import 'package:pixelsky_app/data/message_images.dart';
import 'package:pixelsky_app/demo/demo.dart';
import 'package:pixelsky_app/features/session/message_images.dart';
import 'package:pixelsky_app/features/session/session_screen.dart';
import 'package:pixelsky_app/platform/notifier.dart';
import 'package:pixelsky_app/features/tools/git_screen.dart';
import 'package:pixelsky_app/protocol/json.dart';
import 'package:pixelsky_app/ui/image_viewer.dart';
import 'package:pixelsky_app/features/session/items.dart';
import 'package:pixelsky_app/ui/image_bytes.dart';
import 'package:pixelsky_app/ui/markdown.dart';
import 'package:pixelsky_app/ui/markdown_image.dart';
import 'package:pixelsky_app/ui/theme/theme.dart';

void main() {
  testWidgets('会话里的图：缩略图、全屏看、存相册按钮', (tester) async {
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

    Finder thumbs() => find.descendant(
      of: find.byType(ImageStrip),
      matching: find.byType(Image),
    );

    await until(() => find.text(L10n.title5).evaluate().isNotEmpty, '列表');
    await tester.tap(find.text(L10n.title5).first);
    // 用户消息的一张 + 工具截图的一张，都取到了
    await until(() => find.byType(SessionScreen).evaluate().isNotEmpty, '打开会话');
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await until(() => thumbs().evaluate().length == 2, '两张缩略图');
    expect(find.text('1 张图片'), findsNothing);
    // 回复里的本地图片（§15.17）：经 fileImage 向电脑取到，显示在回复正文里
    await until(
      () => find
          .descendant(
            of: find.byType(ReplyMarkdown),
            matching: find.byType(Image),
          )
          .evaluate()
          .isNotEmpty,
      '回复里的图',
    );

    await tester.tap(thumbs().first);
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byType(ImageViewer), findsOneWidget);
    await until(
      () => find
          .descendant(
            of: find.byType(InteractiveViewer),
            matching: find.byType(Image),
          )
          .evaluate()
          .isNotEmpty,
      '全屏图',
    );
    expect(find.byTooltip('存到相册'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });

  // 审查时发现：列表按位置复用时，缩略图留着上一条消息的图。同一位置换成别的条目要重新取
  testWidgets('同一位置换了条目：缩略图换成新条目的图', (tester) async {
    final demo = DemoDesktop();
    final images = _FakeImages(demo);
    Widget page(String itemId) => MaterialApp(
      theme: buildTheme(Brightness.light),
      home: Scaffold(
        body: MessageImageScope(
          images: images,
          child: ImageStrip(
            itemId: itemId,
            images: const [
              {'width': 320, 'height': 200},
            ],
          ),
        ),
      ),
    );
    Uint8List shown() =>
        ((tester.widget<Image>(find.byType(Image)).image as ResizeImage)
                    .imageProvider
                as MemoryImage)
            .bytes;

    await tester.pumpWidget(page('a'));
    await tester.pump();
    expect(shown(), base64Decode(L10n.shotSettings));
    await tester.pumpWidget(page('b'));
    await tester.pump();
    expect(shown(), base64Decode(L10n.shotBrowser));
    expect(images.calls, ['a/0', 'b/0']);
    demo.dispose();
  });

  testWidgets('Git 图片对比：两张都有、一端没有写原因（§15.17）', (tester) async {
    Widget page(Json images) => MaterialApp(
      theme: buildTheme(Brightness.light),
      home: Scaffold(
        body: SingleChildScrollView(
          child: ImageCompare(images, path: 'assets/a.png'),
        ),
      ),
    );
    final url = 'data:image/png;base64,${L10n.shotSettings}';
    await tester.pumpWidget(
      page({
        'original': {'dataUrl': url, 'bytes': 1},
        'modified': {'dataUrl': url, 'bytes': 1},
      }),
    );
    expect(find.byType(Image), findsNWidgets(2));
    await tester.pumpWidget(
      page({
        'original': null,
        'modified': {'unavailable': 'lfs'},
      }),
    );
    expect(find.byType(Image), findsNothing);
    expect(find.text('没有（新文件）'), findsOneWidget);
    expect(find.textContaining('Git LFS'), findsOneWidget);
  });

  // 审查时发现：文件名里有不合法的 %（100%.png）时取名字会抛，整段回复画不出来
  testWidgets('回复里的图：文件名带 % 不出错', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(Brightness.light),
        home: const Scaffold(body: ReplyMarkdown('看图：\n\n![](./out/100%.png)')),
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(find.textContaining('100%.png'), findsOneWidget);
  });

  test('取不到的图：错误换人话', () {
    expect(imageError(Exception('MOBILE_TOO_LARGE')), contains('太大'));
    expect(imageError(Exception('MOBILE_NOT_FOUND')), contains('不在'));
    // 电脑离线和真的找不到分开说（§16.3）
    expect(imageError(Exception('MOBILE_OFFLINE')), contains('离线'));
  });

  test('SVG 认得出来：开头的空白、XML 声明都跳过，普通图片不算', () {
    expect(
      looksLikeSvg(
        utf8.encode('  <?xml version="1.0"?>\n<svg xmlns="x"></svg>'),
      ),
      isTrue,
    );
    expect(looksLikeSvg(utf8.encode('<svg viewBox="0 0 1 1"/>')), isTrue);
    expect(looksLikeSvg(utf8.encode('<svg>')), isTrue);
    expect(looksLikeSvg(base64Decode(L10n.shotSettings)), isFalse);
    expect(looksLikeSvg(utf8.encode('hello <svg>')), isFalse);
  });

  Widget reply(Widget child) => MaterialApp(
    theme: buildTheme(Brightness.light),
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );

  testWidgets('回复里的 SVG 用 flutter_svg 画（§16.3）', (tester) async {
    await tester.pumpWidget(
      reply(
        MarkdownImages(
          load: (src, scope) async => utf8.encode(
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
          ),
          describe: imageError,
          child: const ReplyMarkdown('图：\n\n![](./logo.svg)'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(SvgPicture), findsOneWidget);
  });

  testWidgets('同一路径在两条回复里：各按自己的回复 id 取，新回复不拿旧图（§16.3）', (tester) async {
    final asked = <String>[];
    final png = base64Decode(L10n.shotSettings);
    await tester.pumpWidget(
      reply(
        MarkdownImages(
          load: (src, scope) async {
            asked.add('$scope|$src');
            return png;
          },
          describe: imageError,
          child: Builder(
            builder: (context) => Column(
              children: [
                MarkdownImages.scoped(
                  context,
                  'r1',
                  child: const ReplyMarkdown('![](./out.png)'),
                ),
                MarkdownImages.scoped(
                  context,
                  'r2',
                  child: const ReplyMarkdown('![](./out.png)'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(asked, unorderedEquals(['r1|./out.png', 'r2|./out.png']));
  });

  testWidgets('排队中消息的图：经 queueImage 取缩略图（§16.3）', (tester) async {
    final images = _FakeImages(DemoDesktop());
    await tester.pumpWidget(
      reply(
        MessageImageScope(
          images: images,
          child: const UserBubble(
            text: '看这张',
            images: 1,
            itemId: 'q1',
            imageMeta: [
              {'name': 'a.png', 'width': 10, 'height': 10},
            ],
            queued: true,
            faded: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(images.calls, ['queue:q1/0']);
  });
}

/// 只认 itemId 给图（不连电脑）：a 给设置页截图，b 给浏览器截图
class _FakeImages extends MessageImages {
  _FakeImages(DemoDesktop demo)
    : super(
        Connections(store: MemoryPairingStore(const []), connect: demo.accept),
        'd',
        's',
      );
  final calls = <String>[];
  @override
  Future<Uint8List> queued(String queueId, int index) {
    calls.add('queue:$queueId/$index');
    return Future.value(base64Decode(L10n.shotBrowser));
  }

  @override
  Future<Uint8List> load(String itemId, int index) {
    calls.add('$itemId/$index');
    return Future.value(
      base64Decode(itemId == 'a' ? L10n.shotSettings : L10n.shotBrowser),
    );
  }
}
