// Codex 回复里的行内标记：照搬 packages/protocol/src/codexDirectives.ts。
// `:codex-file-citation{path="…"}` 标出它引用的文件，`:codex-followup[文字]{…}` 是建议的下一步。
// 在 Markdown 解析之前替换，代码块和行内代码里的原样保留。和 TS 对照的样例：test/fixtures/protocol_text.json。
import 'json.dart';

class CodexCitation {
  const CodexCitation(this.path, this.attributes);
  final String path;

  /// 全部属性（含 path、purpose 等），原样、按出现顺序
  final Map<String, String> attributes;
}

/// 粗略切出代码块（围栏只在行首开、行首关）和行内代码
final _code = RegExp(
  r'((?<=^|\n)[ \t]*```[\s\S]*?(?:\n[ \t]*```|$)|(?<=^|\n)[ \t]*~~~[\s\S]*?(?:\n[ \t]*~~~|$)|`[^`\n]*`)',
);

/// 1～3 个冒号开头；前面紧挨着冒号的不算
final _mark = RegExp(
  r'(?<!:)(:{1,3})(codex-file-citation|codex-followup)(?=[[{])',
);
final _key = RegExp(r'[A-Za-z0-9_-]+');
final _bare = RegExp(r'[^ \t}\r\n]+');

/// 把文字里的 Codex 行内标记换掉：文件引用换成 cite 的结果，下一步建议只留文字；没有标记时原样返回
String replaceCodexDirectives(
  String text,
  String Function(CodexCitation c) cite,
) {
  if (!text.contains('codex-file-citation') &&
      !text.contains(':codex-followup[')) {
    return text;
  }
  // 同 JS 的 text.split(CODE)（带捕获组）：奇数位是代码，原样保留
  final out = StringBuffer();
  var last = 0;
  for (final m in _code.allMatches(text)) {
    out
      ..write(_replacePart(text.substring(last, m.start), cite))
      ..write(m.group(0));
    last = m.end;
  }
  out.write(_replacePart(text.substring(last), cite));
  return out.toString();
}

/// 引用的文件名（链接文字）：路径最后一段
String citationName(String path) {
  final parts = path.split(RegExp(r'[\\/]')).where((p) => p.isNotEmpty);
  return parts.isEmpty ? path : parts.last;
}

/// 纯文字显示（预览、通知）：引用只留文件名
String codexPlainText(String text) =>
    replaceCodexDirectives(text, (c) => citationName(c.path));

String _at(String text, int i) => i >= 0 && i < text.length ? text[i] : '';

String _replacePart(String text, String Function(CodexCitation c) cite) {
  final out = StringBuffer();
  var from = 0;
  var pos = 0;
  while (pos <= text.length) {
    final it = _mark.allMatches(text, pos).iterator;
    if (!it.moveNext()) break;
    final m = it.current;
    pos = m.end;
    // 前面有奇数个 \：被转义了，不是标记
    var slashes = 0;
    while (_at(text, m.start - 1 - slashes) == r'\') {
      slashes++;
    }
    if (slashes.isOdd) continue;
    final name = m.group(2);
    final parsed = _parse(text, m.end, name == 'codex-followup');
    if (parsed == null) continue;
    String? replacement;
    if (name == 'codex-file-citation') {
      final path = parsed.attributes['path'];
      if (path != null && path.isNotEmpty) {
        replacement = cite(CodexCitation(path, parsed.attributes));
      }
    } else if (m.group(1) == ':' &&
        parsed.label != null &&
        jsTrim(parsed.label!).isNotEmpty) {
      replacement = parsed.label;
    }
    if (replacement == null) continue;
    out
      ..write(text.substring(from, m.start))
      ..write(replacement);
    from = pos = parsed.end;
  }
  return from > 0 ? (out..write(text.substring(from))).toString() : text;
}

class _Parsed {
  _Parsed(this.label, this.attributes, this.end);
  final String? label;
  final Map<String, String> attributes;
  final int end;
}

/// 从 [ 或 { 开始解析：[文字]（只有下一步建议有）+ {属性}；值不能跨行，属性不能重复
_Parsed? _parse(String text, int at, bool followup) {
  var i = at;
  String? label;
  if (_at(text, i) == '[') {
    if (!followup) return null;
    var depth = 1;
    var j = i + 1;
    for (; j < text.length; j++) {
      final c = text[j];
      if (c == '\n' || c == '\r') return null;
      if (c == r'\') {
        j++;
      } else if (c == '[') {
        depth++;
      } else if (c == ']' && --depth == 0) {
        break;
      }
    }
    if (j >= text.length) return null;
    label = text.substring(i + 1, j);
    i = j + 1;
  }
  if (_at(text, i) != '{') return null;
  i++;
  final attributes = <String, String>{};
  for (;;) {
    while (_at(text, i) == ' ' || _at(text, i) == '\t') {
      i++;
    }
    if (_at(text, i) == '}') return _Parsed(label, attributes, i + 1);
    final key = _key.matchAsPrefix(text, i)?.group(0);
    if (key == null || attributes.containsKey(key)) return null;
    i += key.length;
    while (_at(text, i) == ' ' || _at(text, i) == '\t') {
      i++;
    }
    if (_at(text, i) != '=') return null;
    i++;
    while (_at(text, i) == ' ' || _at(text, i) == '\t') {
      i++;
    }
    final quote = _at(text, i);
    String value;
    if (quote == '"' || quote == "'") {
      // 引用的路径按字面读（Windows 路径里的 \ 不是转义）；其它标记里 \" 是引号本身
      var j = i + 1;
      for (; j < text.length && text[j] != quote; j++) {
        if (text[j] == '\n' || text[j] == '\r') return null;
        if (followup && text[j] == r'\' && _at(text, j + 1) == quote) j++;
      }
      if (j >= text.length) return null;
      value = text.substring(i + 1, j);
      if (followup) value = value.replaceAll('\\$quote', quote);
      i = j + 1;
    } else {
      final bare = _bare.matchAsPrefix(text, i)?.group(0);
      if (bare == null) return null;
      value = bare;
      i += bare.length;
    }
    attributes[key] = value;
  }
}
