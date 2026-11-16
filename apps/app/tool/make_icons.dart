// 从桌面端图标（apps/desktop/build/icon.png，1024 方、四角透明的圆角方块）生成 App 图标的源图（docs/mobile-app.md §8.6）：
// - tool/icon/ios.png：整块不透明的方图（iOS 自己切圆角，不能有透明）
// - tool/icon/foreground.png：安卓自适应图标的前景，图案缩到 68%（外圈会被各家启动器裁掉）
// - tool/icon/legacy.png：安卓 8 以前的旧图标，原图
// 用法（在 apps/app 里）：dart run tool/make_icons.dart && dart run flutter_launcher_icons
// 背景色同桌面端 brand/badge.svg 的 #1d1915，pubspec.yaml 的 adaptive_icon_background 也是它。
// ignore_for_file: depend_on_referenced_packages, avoid_print
import 'dart:io';

import 'package:image/image.dart' as img;

final background = img.ColorRgba8(0x1d, 0x19, 0x15, 0xff);
const foregroundScale = 0.68;

void main() {
  final source = img.decodePng(
    File('../desktop/build/icon.png').readAsBytesSync(),
  )!;
  final size = source.width;
  Directory('tool/icon').createSync(recursive: true);

  img.Image square(img.Image icon, double scale) {
    final out = img.Image(width: size, height: size, numChannels: 4)
      ..clear(background);
    final side = (size * scale).round();
    final scaled = scale == 1
        ? icon
        : img.copyResize(
            icon,
            width: side,
            height: side,
            interpolation: img.Interpolation.cubic,
          );
    final offset = (size - side) ~/ 2;
    return img.compositeImage(out, scaled, dstX: offset, dstY: offset);
  }

  File('tool/icon/ios.png').writeAsBytesSync(img.encodePng(square(source, 1)));
  File('tool/icon/foreground.png')
      .writeAsBytesSync(img.encodePng(square(source, foregroundScale)));
  File('tool/icon/legacy.png').writeAsBytesSync(img.encodePng(source));
  print('tool/icon/ 下生成了 ios.png、foreground.png、legacy.png（$size 方）');
}
