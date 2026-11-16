// 文件（docs/mobile-app.md §8.4，照网页版 features/tools/FilesScreen.tsx）：浏览项目目录，打开看文件（只读）。
// 目录页：大标题是文件夹名（根目录是项目名），下面一行可点的路径；文件夹在前（强调色图标 + 箭头），文件在后（等宽名、大小、Git 状态）。
// 文件页：文本用回复里那套代码块显示（高亮、复制）；图片直接看；太大 / 不支持给说明。路径都相对项目目录，越界由电脑校验。
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../data/tasks.dart' show Tone;
import '../../data/tools.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/markdown.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import 'common.dart';

final _image = RegExp(
  r'\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$',
  caseSensitive: false,
);

class FilesScreen extends StatefulWidget {
  const FilesScreen(this.tool, {super.key, this.path = ''});
  final ToolContext tool;

  /// 相对项目目录，根目录是空串
  final String path;
  @override
  State<FilesScreen> createState() => _FilesScreenState();
}

class _FilesScreenState extends State<FilesScreen> {
  late final ToolData _list = ToolData(
    AppScope.read(context).connections,
    widget.tool.deviceId,
    'files:list',
    [
      {'projectId': widget.tool.project.id},
      widget.path,
    ],
  );

  @override
  void dispose() {
    _list.dispose();
    super.dispose();
  }

  void _open(String path, {required bool directory}) {
    final nav = Navigator.of(context);
    nav.push(
      MaterialPageRoute<void>(
        builder: (_) => directory
            ? FilesScreen(widget.tool, path: path)
            : _FilePage(tool: widget.tool, path: path),
      ),
    );
  }

  /// 点路径里的一段：回到那一层（之前推进来的页面退掉）
  void _jump(int depth) {
    final parts = widget.path.split('/');
    final up = parts.length - depth;
    var n = 0;
    Navigator.of(context).popUntil((_) => n++ >= up);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final parts = widget.path.isEmpty ? <String>[] : widget.path.split('/');
    return ListenableBuilder(
      listenable: _list,
      builder: (context, _) {
        final data = objOrNull(_list.data);
        final entries = sortEntries([
          for (final e in objList(data?['entries'])) FileEntry(e),
        ]);
        return ToolFrame(
          title: L('文件', 'Files'),
          heading: parts.isEmpty ? widget.tool.project.name : parts.last,
          crumb: parts.isEmpty
              ? null
              : Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    for (var i = 0; i <= parts.length; i++) ...[
                      if (i > 0)
                        Icon(Icons.chevron_right, size: 14, color: c.textFaint),
                      InkWell(
                        onTap: i == parts.length ? null : () => _jump(i),
                        child: Padding(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 2,
                            vertical: 4,
                          ),
                          child: Text(
                            i == 0 ? widget.tool.project.name : parts[i - 1],
                            style: TextStyle(
                              color: i == parts.length
                                  ? c.textSecondary
                                  : c.accentText,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
          loading: _list.loading,
          onRefresh: _list.reload,
          children: [
            if (data == null)
              ToolLoading(error: _list.error)
            else if (entries.isEmpty)
              EmptyState(
                icon: Icons.folder_open_outlined,
                title: L('空文件夹', 'Empty folder'),
              )
            else ...[
              if (_list.error != null)
                ToolBanner(_list.error!, tone: Tone.danger),
              Group(
                children: [
                  for (final e in entries)
                    InkWell(
                      onTap: () => _open(e.path, directory: e.isDirectory),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 16,
                          vertical: 11,
                        ),
                        child: Row(
                          children: [
                            Icon(
                              e.isDirectory
                                  ? Icons.folder_outlined
                                  : _image.hasMatch(e.name)
                                  ? Icons.image_outlined
                                  : Icons.insert_drive_file_outlined,
                              size: 20,
                              color: e.isDirectory ? c.accentText : c.textFaint,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                e.name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: e.isDirectory ? Fs.ui : Fs.meta,
                                  fontFamily: e.isDirectory
                                      ? null
                                      : 'monospace',
                                  color: c.text,
                                ),
                              ),
                            ),
                            if (e.size != null)
                              Text(
                                fileSize(e.size!),
                                style: TextStyle(
                                  fontSize: Fs.label,
                                  fontFamily: 'monospace',
                                  color: c.textFaint,
                                ),
                              ),
                            if (e.status != null) ...[
                              const SizedBox(width: 8),
                              Text(
                                e.status!,
                                style: TextStyle(
                                  fontSize: Fs.label,
                                  fontFamily: 'monospace',
                                  color: c.warn,
                                ),
                              ),
                            ],
                            if (e.isDirectory)
                              Icon(
                                Icons.chevron_right,
                                size: 18,
                                color: c.textFaint,
                              ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
              if (data['truncated'] == true)
                ToolNote(
                  L('文件太多，只列出了一部分。', 'Too many files. Only some are listed.'),
                ),
            ],
          ],
        );
      },
    );
  }
}

/// 文本当代码块显示：围栏比文件里最长的一串反引号还长一个，免得被文件内容截断
String codeFence(String content, String path) {
  var longest = 2;
  for (final m in RegExp(r'`+').allMatches(content)) {
    if (m.group(0)!.length > longest) longest = m.group(0)!.length;
  }
  final fence = '`' * (longest + 1);
  final dot = path.lastIndexOf('.');
  final lang = dot < 0 || dot < path.lastIndexOf('/')
      ? ''
      : path.substring(dot + 1).toLowerCase();
  return '$fence$lang\n$content\n$fence';
}

class _FilePage extends StatefulWidget {
  const _FilePage({required this.tool, required this.path});
  final ToolContext tool;
  final String path;
  @override
  State<_FilePage> createState() => _FilePageState();
}

class _FilePageState extends State<_FilePage> {
  late final ToolData _file = ToolData(
    AppScope.read(context).connections,
    widget.tool.deviceId,
    'files:read',
    [
      {'projectId': widget.tool.project.id},
      widget.path,
    ],
  );

  @override
  void dispose() {
    _file.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final slash = widget.path.lastIndexOf('/');
    final dir = slash < 0 ? '' : widget.path.substring(0, slash);
    return ListenableBuilder(
      listenable: _file,
      builder: (context, _) {
        final doc = objOrNull(_file.data);
        final kind = str(doc?['kind']);
        final bytes = (doc?['bytes'] as num?)?.toInt() ?? 0;
        return ToolFrame(
          title: baseName(widget.path),
          subtitle: dir.isEmpty ? widget.tool.project.name : dir,
          loading: _file.loading,
          onRefresh: _file.reload,
          actions: [
            if (kind == 'text')
              RoundIconButton(
                icon: Icons.copy_outlined,
                tooltip: L('复制', 'Copy'),
                onPressed: () {
                  Clipboard.setData(
                    ClipboardData(text: str(doc!['content']) ?? ''),
                  );
                  ScaffoldMessenger.of(
                    context,
                  ).showSnackBar(SnackBar(content: Text(L('已复制', 'Copied'))));
                },
              ),
          ],
          children: [
            if (doc == null)
              ToolLoading(error: _file.error)
            else if (kind == 'image')
              Column(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.memory(
                      base64Decode((str(doc['dataUrl']) ?? '').split(',').last),
                      errorBuilder: (_, _, _) => const SizedBox(),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    fileSize(bytes),
                    style: TextStyle(fontSize: Fs.label, color: c.textFaint),
                  ),
                ],
              )
            else if (kind == 'unsupported')
              EmptyState(
                icon: Icons.insert_drive_file_outlined,
                title: L('不能在手机上打开', "Can't open on the phone"),
                body: '${str(doc['reason']) ?? ''}（${fileSize(bytes)}）',
              )
            else ...[
              if (doc['cut'] == true)
                ToolBanner(
                  L(
                    '文件太长，只显示了开头一部分，完整的请到电脑上看。',
                    'File too long. Only the beginning is shown; view the full file on your computer.',
                  ),
                  tone: Tone.warn,
                ),
              ReplyMarkdown(codeFence(str(doc['content']) ?? '', widget.path)),
            ],
          ],
        );
      },
    );
  }
}
