// 选图片（相册 / 拍照）和待发送图片的缩略图：输入框、反馈表单共用。图片在手机上压缩（data/images.dart）
import 'package:image_picker/image_picker.dart';
import 'package:material_ui/material_ui.dart';

import '../data/images.dart';
import '../i18n/i18n.dart';
import 'theme/tokens.dart';
import 'widgets.dart';

final _picker = ImagePicker();

/// 先问相册还是拍照，选了就压缩后加进 images；出错时返回说明
Future<String?> pickImagesInto(
  BuildContext context,
  PendingImages images,
) async {
  final source = await showPanel<ImageSource>(
    context,
    (context) => SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Section(
          children: [
            ListRow(
              leading: const Icon(Icons.photo_library_outlined),
              title: L('从相册选', 'Choose from photos'),
              onTap: () => Navigator.pop(context, ImageSource.gallery),
            ),
            ListRow(
              leading: const Icon(Icons.photo_camera_outlined),
              title: L('拍照', 'Take a photo'),
              onTap: () => Navigator.pop(context, ImageSource.camera),
            ),
          ],
        ),
      ),
    ),
  );
  if (source == null) return null;
  try {
    final files = source == ImageSource.gallery
        ? await _picker.pickMultiImage(limit: maxImages)
        : [?await _picker.pickImage(source: ImageSource.camera)];
    if (files.isNotEmpty) await images.add(files);
    return null;
  } catch (e) {
    return '$e';
  }
}

/// 待发送图片的缩略图一排，右上角 × 删掉
class ImageThumbs extends StatelessWidget {
  const ImageThumbs({super.key, required this.images});
  final PendingImages images;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SizedBox(
      height: 72,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 4),
        children: [
          for (final img in images.images)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.memory(
                      imageBytes(img),
                      width: 64,
                      height: 64,
                      fit: BoxFit.cover,
                      gaplessPlayback: true,
                    ),
                  ),
                  Positioned(
                    top: -6,
                    right: -6,
                    child: GestureDetector(
                      onTap: () => images.remove(img['id'] as String),
                      child: Container(
                        decoration: BoxDecoration(
                          color: c.btnPrimaryBg,
                          shape: BoxShape.circle,
                        ),
                        padding: const EdgeInsets.all(3),
                        child: Icon(
                          Icons.close,
                          size: 14,
                          color: c.btnPrimaryText,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (images.busy)
            SizedBox(
              width: 64,
              child: Center(
                child: SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: c.textMuted,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
