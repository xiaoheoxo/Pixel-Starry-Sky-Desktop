// 回复里的 Markdown 图片（docs/mobile-app.md §15.17）：data: 直接解出来，http(s) 直接加载；
// 本地路径（./out.png、/home/…/a.png、file://…）是电脑上的文件，经 MarkdownImages 给的 load 向电脑取
// （会话页给，按这个会话的工作目录读，项目外的不给）。没有 load 时（旁聊、频道、反馈）写一行「图片 · 文件名」。
import 'dart:convert';
import 'dart:typed_data';

import 'package:material_ui/material_ui.dart';

import '../i18n/i18n.dart';
import 'image_bytes.dart';
import 'image_viewer.dart';
import 'theme/theme.dart';
import 'theme/tokens.dart';
import 'theme/type.dart';

class MarkdownImages extends InheritedWidget {
  const MarkdownImages({
    super.key,
    required this.load,
    required this.describe,
    this.scope,
    required super.child,
  });

  /// 在上一层 MarkdownImages 下面给一条回复套上它的 id；没有上一层时原样返回 child
  static Widget scoped(
    BuildContext context,
    String scope, {
    required Widget child,
  }) {
    final parent = maybeOf(context);
    if (parent == null) return child;
    return MarkdownImages(
      load: parent.load,
      describe: parent.describe,
      scope: scope,
      child: child,
    );
  }

  /// 按图片地址（原样）向电脑取；scope 是引用它的那条回复的 id
  final Future<Uint8List> Function(String src, String? scope) load;

  /// 这条回复的 id：取图时带上，新回复引用同一路径不会拿到旧图（§16.3）
  final String? scope;

  /// 取不到的原因换成人话
  final String Function(Object error) describe;

  static MarkdownImages? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<MarkdownImages>();

  @override
  bool updateShouldNotify(MarkdownImages old) =>
      old.load != load || old.describe != describe || old.scope != scope;
}

/// 图片地址是不是网址（http、https、data）；别的当本地路径
bool _remote(String src) =>
    RegExp(r'^(https?|data):', caseSensitive: false).hasMatch(src);

/// 回复里一张图：最高 240，宽度跟着正文，点开全屏
Widget markdownImage(BuildContext context, String src) =>
    _MarkdownImage(src: src.trim());

class _MarkdownImage extends StatefulWidget {
  const _MarkdownImage({required this.src});
  final String src;
  @override
  State<_MarkdownImage> createState() => _MarkdownImageState();
}

class _MarkdownImageState extends State<_MarkdownImage> {
  Future<Uint8List>? _bytes;
  String? _for;

  String get _name {
    final path = widget.src.toLowerCase().startsWith('data:')
        ? ''
        : widget.src.split(RegExp(r'[\\/]')).last;
    if (path.isEmpty) return L('图片', 'Image');
    // 文件名里有不合法的 %（100%.png）时 decodeComponent 会抛，原样显示
    try {
      return Uri.decodeComponent(path);
    } on ArgumentError {
      return path;
    }
  }

  /// 网络图：交给 Image.network；data: 和本地路径：取到字节
  Future<Uint8List>? _load(MarkdownImages? source) {
    final src = widget.src;
    if (src.toLowerCase().startsWith('data:')) {
      final comma = src.indexOf(',');
      return Future(() => base64Decode(src.substring(comma + 1)));
    }
    if (_remote(src)) return null;
    return source?.load(src, source.scope);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final source = MarkdownImages.maybeOf(context);
    final key =
        '${widget.src}|${identityHashCode(source?.load)}|${source?.scope}';
    if (_for != key) {
      _for = key;
      _bytes = _load(source);
    }
    final local = !_remote(widget.src);
    if (local && source == null) return _Placeholder(_name, null);
    Widget frame(Widget child) => ConstrainedBox(
      constraints: const BoxConstraints(maxHeight: 240),
      // 细边框：白底截图在浅色背景上也看得出边（同会话里的缩略图）
      child: Container(
        foregroundDecoration: BoxDecoration(
          border: Border.all(color: c.borderSubtle),
          borderRadius: BorderRadius.circular(Radii.code),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(Radii.code),
          child: child,
        ),
      ),
    );
    if (_bytes == null) {
      // 网络图：手机直接加载（同电脑的 <img>）
      return frame(
        Image.network(
          widget.src,
          fit: BoxFit.contain,
          errorBuilder: (_, _, _) => _Placeholder(_name, null),
        ),
      );
    }
    return FutureBuilder<Uint8List>(
      future: _bytes,
      builder: (context, snap) {
        if (snap.hasError) {
          return InkWell(
            // 点一下重取
            onTap: () => setState(() => _for = null),
            child: _Placeholder(
              _name,
              (source?.describe ?? (e) => '$e')(snap.error!),
            ),
          );
        }
        final data = snap.data;
        if (data == null) {
          return SizedBox(
            height: 48,
            child: Row(
              children: [
                SizedBox.square(
                  dimension: 14,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.5,
                    color: c.textMuted,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  _name,
                  style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                ),
              ],
            ),
          );
        }
        return GestureDetector(
          onTap: () => _open(context, data),
          child: frame(
            bytesImage(data, onError: () => _Placeholder(_name, null)),
          ),
        );
      },
    );
  }

  void _open(BuildContext context, Uint8List data) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ImageViewer(title: _name, load: () async => data),
      ),
    );
  }
}

/// 拿不到的图：一行「图片 · 文件名」，有原因时下面写原因
class _Placeholder extends StatelessWidget {
  const _Placeholder(this.name, this.reason);
  final String name;
  final String? reason;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.broken_image_outlined, size: 16, color: c.textFaint),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              reason == null ? name : '$name · $reason',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
            ),
          ),
        ],
      ),
    );
  }
}
