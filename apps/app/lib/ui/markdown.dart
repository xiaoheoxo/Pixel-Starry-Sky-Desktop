// 回复正文的 Markdown：先换掉 Codex 的行内标记（文件引用显示成文件名），再交给 gpt_markdown。
// 选型见 docs/mobile-app.md §13.1（A0 实测：中文加粗、半截代码块和表格处理得好，代码块自带复制和高亮、表格横滚）。
// 整篇交给一个 GptMarkdown 时每次更新的耗时随全文变长（5 万字约 5.5 ms，慢手机会掉帧），所以按空行拆成块，
// 每块一个 GptMarkdown；已经定型的块缓存住不重建，流式时只重画最后一块（实测耗时变平，1.6 → 1.8 ms）。
// 换库时只改这一个文件。
import 'package:flutter/services.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:material_ui/material_ui.dart';

import '../i18n/i18n.dart';
import '../protocol/codex_directives.dart';
import 'theme/theme.dart';
import 'theme/tokens.dart';
import 'theme/type.dart';

/// 按空行把 Markdown 拆成块；代码块（``` 或 ~~~ 围起来的）里的空行不拆。拼回去和原文一致（块之间用空行连）
List<String> splitBlocks(String text) {
  final blocks = <String>[];
  final lines = <String>[];
  String? fence;
  void flush() {
    if (lines.isNotEmpty) blocks.add(lines.join('\n'));
    lines.clear();
  }

  for (final line in text.split('\n')) {
    final t = line.trimLeft();
    if (fence == null) {
      if (t.startsWith('```') || t.startsWith('~~~')) {
        fence = t.substring(0, 3);
      } else if (line.trim().isEmpty) {
        flush();
        continue;
      }
    } else if (t.startsWith(fence) && t.substring(3).trim().isEmpty) {
      fence = null;
    }
    lines.add(line);
  }
  flush();
  return blocks;
}

class ReplyMarkdown extends StatefulWidget {
  const ReplyMarkdown(this.text, {super.key});
  final String text;

  @override
  State<ReplyMarkdown> createState() => _ReplyMarkdownState();
}

class _ReplyMarkdownState extends State<ReplyMarkdown> {
  /// 已经画过的块：同一位置、同样的文字就用同一个 widget 实例（Flutter 遇到同一个实例不重建）
  final _cache = <({String text, Widget widget})>[];
  Brightness? _brightness;

  Widget _block(BuildContext context, String source) {
    final c = context.colors;
    return GptMarkdown(
      source,
      style: TextStyle(fontSize: Fs.prose, height: Lh.prose, color: c.textBody),
      // 手机上不直接打开链接（还没接系统浏览器）：复制下来
      onLinkTap: (url, title) {
        Clipboard.setData(ClipboardData(text: url));
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(L('已复制链接', 'Link copied'))));
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    // 换了主题：缓存里的颜色是旧的，全部重画
    final brightness = Theme.of(context).brightness;
    if (brightness != _brightness) {
      _cache.clear();
      _brightness = brightness;
    }
    final source = replaceCodexDirectives(
      widget.text,
      (x) => '`${citationName(x.path)}`',
    );
    final blocks = splitBlocks(source);
    for (var i = 0; i < blocks.length; i++) {
      if (i < _cache.length && _cache[i].text == blocks[i]) continue;
      final entry = (text: blocks[i], widget: _block(context, blocks[i]));
      if (i < _cache.length) {
        _cache[i] = entry;
      } else {
        _cache.add(entry);
      }
    }
    if (_cache.length > blocks.length) {
      _cache.removeRange(blocks.length, _cache.length);
    }
    final body = _cache.length == 1
        ? _cache.first.widget
        : Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < _cache.length; i++) ...[
                if (i > 0) const SizedBox(height: 10),
                _cache[i].widget,
              ],
            ],
          );
    return GptMarkdownTheme(gptThemeData: markdownTheme(context), child: body);
  }
}

/// 回复正文的样子：标题照设计变量（一级标题 1.2857 倍正文，其余不再放大）；行内代码用 code-inline 颜色、不加边框；
/// 表格 border-card 细线、表头 bg-subtle、比正文小一级、放不下横向滚动；代码块小一级、横向滚动。
GptMarkdownThemeData markdownTheme(BuildContext context) {
  final c = context.colors;
  TextStyle heading(double size) =>
      TextStyle(fontSize: size, fontWeight: FontWeight.w600, color: c.text);
  return GptMarkdownThemeData(
    brightness: Theme.of(context).brightness,
    h1: heading(Fs.prose * 1.2857),
    h2: heading(Fs.section),
    h3: heading(Fs.prose),
    h4: heading(Fs.prose),
    h5: heading(Fs.prose),
    h6: heading(Fs.prose),
    autoAddDividerLineAfterH1: false,
    hrLineColor: c.borderSubtle,
    linkColor: c.accentText,
    linkHoverColor: c.accentText,
    inlineCode: InlineCodeStyle(
      color: c.codeInlineText,
      backgroundColor: c.codeInlineBg,
      borderWidth: 0,
      fontSizeFactor: 0.9,
      borderRadius: const Radius.circular(6),
    ),
    styleSheet: GptMarkdownStyleSheet(
      table: TableStyle(
        borderColor: c.borderCard,
        borderWidth: 1,
        borderRadius: const Radius.circular(10),
        headerBackground: c.bgSubtle,
        headerTextStyle: TextStyle(
          fontSize: Fs.list,
          fontWeight: FontWeight.w600,
          color: c.text,
        ),
        cellPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        overflow: TableOverflow.scroll,
      ),
      codeBlock: CodeBlockStyle(
        backgroundColor: c.bgSubtle,
        borderColor: c.borderCard,
        borderWidth: 1,
        borderRadius: const Radius.circular(Radii.code),
        fontSize: Fs.list,
        languageStyle: TextStyle(fontSize: Fs.label, color: c.textMuted),
      ),
    ),
  );
}
