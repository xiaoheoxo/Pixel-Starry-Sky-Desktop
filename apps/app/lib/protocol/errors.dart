// 宿主错误代码：照搬 packages/protocol/src/errors.ts。主进程 / 引擎抛的错误把代码和参数编码进 message（前缀 + JSON），
// 界面按 errors.<code> 查词典翻译。和 TS 对照的样例：test/fixtures/protocol_text.json。
import 'dart:convert';

import 'json.dart';

const errorPrefix = 'PIXELSKY_ERR:';

class CodedErrorInfo {
  const CodedErrorInfo(this.code, this.params);
  final String code;

  /// 只有字符串和数字
  final Map<String, Object> params;
}

// 片段结束处：行尾、空白或标点
final _fragmentEnd = RegExp(r'^$|^[\s,.;:，。；：）)]');

CodedErrorInfo? _decode(String text) {
  Object? value;
  try {
    value = jsonDecode(text);
  } on FormatException {
    return null;
  }
  if (value is! Map) return null;
  final code = value['code'];
  if (code is! String || code.isEmpty) return null;
  final params = <String, Object>{};
  final raw = value['params'];
  if (raw is Map) {
    for (final entry in raw.entries) {
      final v = entry.value;
      if (v is String || v is num) params[entry.key as String] = v as Object;
    }
  }
  return CodedErrorInfo(code, params);
}

/// 整条消息就是一个带代码的错误时返回代码和参数，否则 null
CodedErrorInfo? parseCodedError(String? message) {
  final value = jsTrim(message ?? '');
  if (!value.startsWith(errorPrefix)) return null;
  return _decode(value.substring(errorPrefix.length));
}

/// 把消息里所有带代码的错误片段换成 render 的结果
String replaceCodedErrors(
  String message,
  String Function(CodedErrorInfo info) render,
) {
  if (!message.contains(errorPrefix)) return message;
  final result = StringBuffer();
  var from = 0;
  for (
    var at = message.indexOf(errorPrefix);
    at >= 0;
    at = message.indexOf(errorPrefix, at + 1)
  ) {
    if (at < from) continue;
    final start = at + errorPrefix.length;
    if (start >= message.length || message[start] != '{') continue;
    final lineEnd = message.indexOf('\n', start);
    final stop = lineEnd < 0 ? message.length : lineEnd;
    // 参数里可能有「}」紧跟空白或标点，从近到远逐个试候选结束位置，第一个能解析的就是
    for (
      var close = message.indexOf('}', start);
      close >= 0 && close < stop;
      close = message.indexOf('}', close + 1)
    ) {
      final next = close + 1 < message.length
          ? message.substring(close + 1, close + 2)
          : '';
      if (!_fragmentEnd.hasMatch(next)) continue;
      final info = _decode(message.substring(start, close + 1));
      if (info == null) continue;
      result
        ..write(message.substring(from, at))
        ..write(render(info));
      from = close + 1;
      break;
    }
  }
  return (result..write(message.substring(from))).toString();
}
