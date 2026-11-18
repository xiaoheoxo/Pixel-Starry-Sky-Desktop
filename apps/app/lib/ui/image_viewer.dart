// 全屏看一张图（会话里的图、回复里的图、Git 图片对比共用）：双指放大，右上角存到相册
import 'dart:typed_data';

import 'package:gal/gal.dart';
import 'package:material_ui/material_ui.dart';

import '../i18n/i18n.dart';
import 'image_bytes.dart';
import 'widgets.dart';

class ImageViewer extends StatefulWidget {
  const ImageViewer({
    super.key,
    required this.title,
    required this.load,
    this.describe,
  });
  final String title;
  final Future<Uint8List> Function() load;

  /// 取不到时的原因（换成人话）；不给就写错误本身
  final String Function(Object error)? describe;

  @override
  State<ImageViewer> createState() => _ImageViewerState();
}

class _ImageViewerState extends State<ImageViewer> {
  late final Future<Uint8List> _bytes = widget.load();
  bool _saving = false;

  void _toast(String text) =>
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(text)));

  Future<void> _save(Uint8List data) async {
    setState(() => _saving = true);
    try {
      if (!await Gal.hasPermission() && !await Gal.requestPermission()) {
        if (mounted) _toast(L('没有存相册的权限', 'No permission to save photos'));
        return;
      }
      await Gal.putImageBytes(
        data,
        name: 'pixelsky-${DateTime.now().millisecondsSinceEpoch}',
      );
      if (mounted) _toast(L('已存到相册', 'Saved to Photos'));
    } catch (e) {
      if (mounted) _toast(L('存不了：$e', "Couldn't save: $e"));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Uint8List>(
      future: _bytes,
      builder: (context, snap) {
        final data = snap.data;
        return AppScreen(
          title: widget.title,
          leading: RoundIconButton(
            icon: Icons.arrow_back,
            tooltip: L('返回', 'Back'),
            onPressed: () => Navigator.of(context).pop(),
          ),
          trailing: [
            // SVG 存不进相册（相册只认位图）
            if (data != null && !looksLikeSvg(data))
              RoundIconButton(
                icon: Icons.download_outlined,
                tooltip: L('存到相册', 'Save to Photos'),
                onPressed: _saving ? null : () => _save(data),
              ),
          ],
          body: snap.hasError
              ? EmptyState(
                  icon: Icons.broken_image_outlined,
                  title: L('打不开这张图', "Can't open this image"),
                  body: (widget.describe ?? (e) => '$e')(snap.error!),
                )
              : data == null
              ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
              : InteractiveViewer(
                  maxScale: 6,
                  child: Center(
                    child: bytesImage(
                      data,
                      onError: () => EmptyState(
                        icon: Icons.broken_image_outlined,
                        title: L('打不开这张图', "Can't open this image"),
                      ),
                    ),
                  ),
                ),
        );
      },
    );
  }
}
