// A4c：宽屏断点只认平板
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' show Size;
import 'package:pixelsky_app/ui/layout.dart';

void main() {
  test('抽屉常驻：宽 ≥ 900 且短边 ≥ 600；手机横屏不算', () {
    expect(pinsDrawer(const Size(411, 914)), isFalse); // 手机竖屏
    expect(pinsDrawer(const Size(914, 411)), isFalse); // 手机横屏
    expect(pinsDrawer(const Size(1000, 600)), isTrue);
    expect(pinsDrawer(const Size(800, 1280)), isFalse); // 平板竖屏不够宽
  });
  test('右边工具栏：宽 ≥ 1280 且是平板', () {
    expect(fitsSidePanel(const Size(1280, 800)), isTrue);
    expect(fitsSidePanel(const Size(1279, 800)), isFalse);
    expect(fitsSidePanel(const Size(1300, 500)), isFalse);
  });
}
