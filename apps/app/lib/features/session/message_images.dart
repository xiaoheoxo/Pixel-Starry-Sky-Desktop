// 消息里的图片（docs/mobile-app.md §15.16）：用户消息、工具结果里的图显示成缩略图，看到时才向电脑取；
// 点开全屏看（双指放大）、存到相册。会话页在列表外面放 MessageImageScope；没有时（排队预览、测试）只写「N 张图片」。
import 'dart:typed_data';

import 'package:material_ui/material_ui.dart';

import '../../data/message_images.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/image_viewer.dart';

class MessageImageScope extends InheritedWidget {
  const MessageImageScope({
    super.key,
    required this.images,
    required super.child,
  });
  final MessageImages images;

  static MessageImages? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<MessageImageScope>()?.images;

  @override
  bool updateShouldNotify(MessageImageScope old) => old.images != images;
}

/// 一条消息的几张图：一张时按宽高比放大一点，多张时一排方块
class ImageStrip extends StatelessWidget {
  const ImageStrip({
    super.key,
    required this.itemId,
    required this.images,
    this.queued = false,
  });
  final String itemId;
  final List<Json> images;

  /// 排队中消息的图（itemId 是队列里的 id）
  final bool queued;

  @override
  Widget build(BuildContext context) {
    final source = MessageImageScope.maybeOf(context);
    if (source == null || images.isEmpty) return ImageCount(images.length);
    final single = images.length == 1;
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [
        for (var i = 0; i < images.length; i++)
          _Thumb(
            source: source,
            itemId: itemId,
            index: i,
            queued: queued,
            meta: images[i],
            size: single ? _singleSize(images[i]) : const Size(72, 72),
          ),
      ],
    );
  }

  static Size _singleSize(Json meta) {
    final w = (meta['width'] as num?)?.toDouble() ?? 0;
    final h = (meta['height'] as num?)?.toDouble() ?? 0;
    if (w <= 0 || h <= 0) return const Size(160, 120);
    // 长边 180，短边至少 64
    final scale = 180 / (w > h ? w : h);
    return Size((w * scale).clamp(64, 180), (h * scale).clamp(64, 180));
  }
}

/// 拿不到图时的一行「N 张图片」
class ImageCount extends StatelessWidget {
  const ImageCount(this.count, {super.key});
  final int count;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    if (count == 0) return const SizedBox();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.image_outlined, size: 14, color: c.textMuted),
        const SizedBox(width: 4),
        Text(
          L('$count 张图片', '$count images'),
          style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
        ),
      ],
    );
  }
}

class _Thumb extends StatefulWidget {
  const _Thumb({
    required this.source,
    required this.itemId,
    required this.index,
    required this.queued,
    required this.meta,
    required this.size,
  });
  final MessageImages source;
  final String itemId;
  final int index;
  final bool queued;
  final Json meta;
  final Size size;

  @override
  State<_Thumb> createState() => _ThumbState();
}

class _ThumbState extends State<_Thumb> {
  late Future<Uint8List> _bytes = _load();

  Future<Uint8List> _load() => widget.queued
      ? widget.source.queued(widget.itemId, widget.index)
      : widget.source.load(widget.itemId, widget.index);

  @override
  void didUpdateWidget(_Thumb old) {
    super.didUpdateWidget(old);
    // 这个位置换成了别的条目 / 别的一张：重新取，不显示上一张
    if (old.itemId != widget.itemId ||
        old.queued != widget.queued ||
        old.index != widget.index ||
        old.source != widget.source) {
      _bytes = _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final name = str(widget.meta['name']) ?? L('图片', 'Image');
    return Semantics(
      button: true,
      label: name,
      child: GestureDetector(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) =>
                ImageViewer(title: name, load: _load, describe: imageError),
          ),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(Radii.code),
          child: Container(
            width: widget.size.width,
            height: widget.size.height,
            color: c.bgSubtle,
            // 细边框：白底截图在浅色背景上也看得出边
            foregroundDecoration: BoxDecoration(
              border: Border.all(color: c.borderSubtle),
              borderRadius: BorderRadius.circular(Radii.code),
            ),
            child: FutureBuilder<Uint8List>(
              future: _bytes,
              builder: (context, snap) {
                if (snap.hasError) {
                  return Tooltip(
                    message: imageError(snap.error!),
                    child: InkWell(
                      // 点一下重取（比如刚才没连上）
                      onTap: () => setState(() => _bytes = _load()),
                      child: Icon(
                        Icons.broken_image_outlined,
                        color: c.textFaint,
                      ),
                    ),
                  );
                }
                final data = snap.data;
                if (data == null) {
                  return Icon(Icons.image_outlined, color: c.textFaint);
                }
                // 缩略图按显示大小解码，不按原图；铺满（cover）时按短边解码，宽图放进方块不糊
                final dpr = MediaQuery.devicePixelRatioOf(context);
                final w = (widget.meta['width'] as num?) ?? 0;
                final h = (widget.meta['height'] as num?) ?? 0;
                final wide = w > 0 && h > 0 && w / h > widget.size.aspectRatio;
                return Image.memory(
                  data,
                  fit: BoxFit.cover,
                  cacheWidth: wide ? null : (widget.size.width * dpr).round(),
                  cacheHeight: wide ? (widget.size.height * dpr).round() : null,
                  gaplessPlayback: true,
                  errorBuilder: (_, _, _) =>
                      Icon(Icons.broken_image_outlined, color: c.textFaint),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}
