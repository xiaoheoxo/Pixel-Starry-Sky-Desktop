// 手机日志（docs/mobile-app.md §19）：记录、落盘、换文件、截断、附进反馈
import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixelsky_app/app/log.dart';
import 'package:pixelsky_app/data/feedback.dart';
import 'package:pixelsky_app/features/settings/log_screen.dart';
import 'package:pixelsky_app/i18n/i18n.dart';
import 'package:pixelsky_app/ui/theme/theme.dart';

class _MemoryStore implements LogStore {
  _MemoryStore([List<String>? lines]) : lines = lines ?? [];
  final List<String> lines;
  @override
  Future<List<String>> load() async => [...lines];
  @override
  Future<void> append(String line) async => lines.add(line);
  @override
  Future<void> clear() async => lines.clear();
}

class _SlowStore extends _MemoryStore {
  _SlowStore(this.gate);
  final Future<void> gate;
  @override
  Future<List<String>> load() async {
    await gate;
    return [];
  }
}

void main() {
  setUp(() => language.value = AppLanguage.zh);

  test('接上文件：以前的在前、接上之前记的在后并补写进去；坏行跳过', () async {
    final old = (
      at: DateTime(2026, 11, 17, 9),
      level: LogLevel.warn,
      source: '连接',
      text: '旧的',
    );
    final store = _MemoryStore([encodeLogLine(old), 'not json', '{"t":1}']);
    final log = AppLog()..error('程序', '早的');
    await log.attach(store);
    expect(log.entries.map((e) => e.text), ['旧的', '早的']);
    expect(store.lines.length, 4);
    log.info('连接', '新的');
    expect(decodeLogLine(store.lines.last)?.text, '新的');
    await log.clear();
    expect(log.entries, isEmpty);
    expect(store.lines, isEmpty);
  });

  test('读旧文件期间记的日志不丢，也补写进文件', () async {
    final gate = Completer<void>();
    final store = _SlowStore(gate.future);
    final log = AppLog();
    final attaching = log.attach(store);
    log.warn('连接', '读文件时记的');
    gate.complete();
    await attaching;
    expect(log.entries.map((e) => e.text), ['读文件时记的']);
    expect(store.lines.map((l) => decodeLogLine(l)?.text), ['读文件时记的']);
  });

  test('内存里只留最近 limit 条', () {
    final log = AppLog(limit: 3);
    for (var i = 0; i < 5; i++) {
      log.info('x', '$i');
    }
    expect(log.entries.map((e) => e.text), ['2', '3', '4']);
  });

  test('太长的截掉：堆栈留 30 行', () {
    final text = List.generate(50, (i) => 'line $i').join('\n');
    final clipped = clipLogText(text).split('\n');
    expect(clipped.length, 31);
    expect(clipped.last, '…');
    expect(clipLogText('a' * 5000).length, 4001);
  });

  test('纯文字：一条一行、堆栈缩进；只留末尾放得下的整行', () {
    final at = DateTime(2026, 11, 18, 8, 7, 3);
    final text = logText([
      (at: at, level: LogLevel.error, source: '界面', text: 'boom\n#0 main'),
    ]);
    expect(text, '11-18 08:07:03 E [界面] boom\n    #0 main');
    expect(tailLines('aaa\nbbb\nccc', 8), 'bbb\nccc');
    expect(tailLines('short', 100), 'short');
  });

  test('最近 2 小时', () {
    final now = DateTime(2026, 11, 18, 12);
    LogEntry at(int h) => (
      at: DateTime(2026, 11, 18, h),
      level: LogLevel.info,
      source: 's',
      text: '$h',
    );
    final r = recentLogs(
      [at(9), at(10), at(11)],
      const Duration(hours: 2),
      now,
    );
    expect(r.map((e) => e.text), ['10', '11']);
  });

  test('文件：满了换到 .1，只留两个；读回两个文件的行', () async {
    final dir = await Directory.systemTemp.createTemp('pixelsky-log-');
    addTearDown(() => dir.delete(recursive: true));
    final store = FileLogStore(dir.path, maxBytes: 20);
    for (var i = 0; i < 6; i++) {
      await store.append('line-$i-xxxxxx');
    }
    final files = dir.listSync().map((f) => f.uri.pathSegments.last).toSet();
    expect(files, {'pixelsky.log', 'pixelsky.1.log'});
    final lines = await store.load();
    expect(lines.last, 'line-5-xxxxxx');
    expect(lines.length, lessThan(6));
    await store.clear();
    expect(await store.load(), isEmpty);
  });

  test('反馈正文：手机日志放最后的代码块里', () {
    final body = composeFeedbackBody(
      body: '闪退',
      phone: 'Pixel 9',
      phoneLog: '11-18 08:07:03 E [界面] boom',
    );
    expect(
      body,
      endsWith('## 手机日志（最近 2 小时）\n```\n11-18 08:07:03 E [界面] boom\n```'),
    );
    expect(composeFeedbackBody(body: 'x', phone: 'p'), isNot(contains('手机日志')));
  });

  testWidgets('日志页：新的在上面，只看警告和错误', (tester) async {
    final log = AppLog()
      ..info('连接', '已连上')
      ..error('调用', 'quota 失败：MOBILE_UNSUPPORTED');
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(Brightness.light),
        home: LogScreen(log: log),
      ),
    );
    expect(find.text('已连上'), findsOneWidget);
    final first = tester
        .getTopLeft(find.text('quota 失败：MOBILE_UNSUPPORTED'))
        .dy;
    expect(first, lessThan(tester.getTopLeft(find.text('已连上')).dy));
    await tester.tap(find.text('只看警告和错误'));
    await tester.pump();
    expect(find.text('已连上'), findsNothing);
    expect(find.text('quota 失败：MOBILE_UNSUPPORTED'), findsOneWidget);
  });
}
