// 手机日志（docs/mobile-app.md §19，D340）：只记事件和错误码，不记消息正文、参数、密钥、配对码、邮箱。
// 内存里留最近 2000 条给日志页；接上文件后每条追加一行 JSON，满 512 KB 换一个文件、只留两个。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

enum LogLevel { info, warn, error }

typedef LogEntry = ({DateTime at, LogLevel level, String source, String text});

/// 一条日志落盘的地方（测试里换成内存的）
abstract class LogStore {
  Future<List<String>> load();
  Future<void> append(String line);
  Future<void> clear();
}

class AppLog extends ChangeNotifier {
  AppLog({this.limit = 2000});

  final int limit;
  final _entries = <LogEntry>[];
  LogStore? _store;

  /// 旧的在前
  List<LogEntry> get entries => List.unmodifiable(_entries);

  /// 接上文件：先读出以前的（接上之前已经记的排在后面），之后每条都写进去
  Future<void> attach(LogStore store) async {
    final old = <LogEntry>[];
    try {
      for (final line in await store.load()) {
        final e = decodeLogLine(line);
        if (e != null) old.add(e);
      }
    } catch (_) {
      // 读不出来就当没有
    }
    // 读文件期间记下的也算「之前的」：在 await 之后才取，接上文件前不会再有新的插进来
    final early = [..._entries];
    _store = store;
    _entries
      ..clear()
      ..addAll(old)
      ..addAll(early);
    _trim();
    for (final e in early) {
      _write(e);
    }
    notifyListeners();
  }

  void info(String source, String text) => add(LogLevel.info, source, text);
  void warn(String source, String text) => add(LogLevel.warn, source, text);
  void error(String source, String text) => add(LogLevel.error, source, text);

  void add(LogLevel level, String source, String text, [DateTime? at]) {
    final e = (
      at: at ?? DateTime.now(),
      level: level,
      source: source,
      text: clipLogText(text),
    );
    _entries.add(e);
    _trim();
    _write(e);
    notifyListeners();
  }

  Future<void> clear() async {
    _entries.clear();
    notifyListeners();
    try {
      await _store?.clear();
    } catch (_) {}
  }

  void _trim() {
    if (_entries.length > limit) {
      _entries.removeRange(0, _entries.length - limit);
    }
  }

  void _write(LogEntry e) {
    final store = _store;
    if (store == null) return;
    store.append(encodeLogLine(e)).catchError((Object _) {});
  }
}

/// 全 App 共用一个；main 里接上文件和异常钩子
final appLog = AppLog();

/// 太长的截掉：堆栈留前 30 行，整条最多 4000 字
String clipLogText(String text) {
  var lines = text.trimRight().split('\n');
  if (lines.length > 30) lines = [...lines.take(30), '…'];
  final s = lines.join('\n');
  return s.length > 4000 ? '${s.substring(0, 4000)}…' : s;
}

String encodeLogLine(LogEntry e) => jsonEncode({
  't': e.at.toIso8601String(),
  'l': e.level.name,
  's': e.source,
  'm': e.text,
});

LogEntry? decodeLogLine(String line) {
  try {
    final j = jsonDecode(line);
    if (j is! Map) return null;
    final at = DateTime.tryParse('${j['t']}');
    final level = LogLevel.values.where((l) => l.name == j['l']);
    final source = j['s'], text = j['m'];
    if (at == null || level.isEmpty || source is! String || text is! String) {
      return null;
    }
    return (at: at, level: level.first, source: source, text: text);
  } on FormatException {
    return null;
  }
}

String _two(int n) => n.toString().padLeft(2, '0');

/// 「11-18 08:07:03」
String logTime(DateTime at) =>
    '${_two(at.month)}-${_two(at.day)} ${_two(at.hour)}:${_two(at.minute)}:${_two(at.second)}';

String logLevelMark(LogLevel l) => switch (l) {
  LogLevel.info => 'I',
  LogLevel.warn => 'W',
  LogLevel.error => 'E',
};

/// 复制 / 附进反馈的纯文字：一条一行（堆栈另起行缩进），旧的在前
String logText(Iterable<LogEntry> entries) => entries
    .map(
      (e) =>
          '${logTime(e.at)} ${logLevelMark(e.level)} [${e.source}] ${e.text.replaceAll('\n', '\n    ')}',
    )
    .join('\n');

/// 最近 since 这段时间的
List<LogEntry> recentLogs(
  List<LogEntry> entries,
  Duration since, [
  DateTime? now,
]) {
  final from = (now ?? DateTime.now()).subtract(since);
  return [
    for (final e in entries)
      if (!e.at.isBefore(from)) e,
  ];
}

/// 存在 App 私有目录：pixelsky.log 满 maxBytes 改名成 pixelsky.1.log（旧的 .1 丢掉）
class FileLogStore implements LogStore {
  FileLogStore(this.dir, {this.maxBytes = 512 * 1024});
  final String dir;
  final int maxBytes;
  Future<void> _queue = Future.value();
  int? _size;

  File get _current => File('$dir/pixelsky.log');
  File get _previous => File('$dir/pixelsky.1.log');

  Future<T> _serial<T>(Future<T> Function() run) {
    final next = _queue.then((_) => run());
    _queue = next.then((_) {}, onError: (Object _) {});
    return next;
  }

  @override
  Future<List<String>> load() => _serial(() async {
    final lines = <String>[];
    for (final f in [_previous, _current]) {
      if (await f.exists()) {
        lines.addAll(
          (await f.readAsString()).split('\n').where((l) => l.isNotEmpty),
        );
      }
    }
    return lines;
  });

  @override
  Future<void> append(String line) => _serial(() async {
    await Directory(dir).create(recursive: true);
    final f = _current;
    _size ??= await f.exists() ? await f.length() : 0;
    if (_size! >= maxBytes) {
      await f.rename(_previous.path);
      _size = 0;
    }
    final bytes = utf8.encode('$line\n');
    await f.writeAsBytes(bytes, mode: FileMode.append);
    _size = _size! + bytes.length;
  });

  @override
  Future<void> clear() => _serial(() async {
    for (final f in [_previous, _current]) {
      if (await f.exists()) await f.delete();
    }
    _size = 0;
  });
}

/// 没接住的异常都进日志（界面里的、异步里的）
void catchErrorsIntoLog(AppLog log) {
  final previous = FlutterError.onError;
  FlutterError.onError = (details) {
    log.error('界面', '${details.exceptionAsString()}\n${details.stack ?? ''}');
    previous?.call(details);
  };
  PlatformDispatcher.instance.onError = (error, stack) {
    log.error('程序', '$error\n$stack');
    return true;
  };
}

/// 只留末尾能放进 max 字的整行（附进反馈时用：新的在后，从旧的开始丢）
String tailLines(String text, int max) {
  if (text.length <= max) return text;
  final lines = text.split('\n');
  final kept = <String>[];
  var size = 0;
  for (final line in lines.reversed) {
    if (size + line.length + 1 > max) break;
    kept.add(line);
    size += line.length + 1;
  }
  return kept.reversed.join('\n');
}
