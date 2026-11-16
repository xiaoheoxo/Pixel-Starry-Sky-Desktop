// 宽屏断点（docs/mobile-app.md §8.4，同网页版 App.tsx）：≥ 900 抽屉常驻左边，≥ 1280 会话页的工具放右边一栏。
// 只认平板（短边 ≥ 600）：手机横过来也有 900 多宽，但只有 400 高，常驻抽屉里放不下会话列表。
import 'package:material_ui/material_ui.dart';

abstract final class Breakpoints {
  /// 抽屉常驻左边
  static const pinDrawer = 900.0;

  /// 会话页打开的工具放右边一栏
  static const sidePanel = 1280.0;

  /// 短边至少这么多才算平板
  static const tablet = 600.0;
}

abstract final class PaneWidth {
  static const drawer = 300.0;
  static const side = 400.0;

  /// 页面内容（对话、列表）最宽这么多，更宽时居中
  static const content = 720.0;
}

bool drawerPinned(BuildContext context) =>
    pinsDrawer(MediaQuery.sizeOf(context));

bool sidePanelFits(BuildContext context) =>
    fitsSidePanel(MediaQuery.sizeOf(context));

bool pinsDrawer(Size size) =>
    size.width >= Breakpoints.pinDrawer &&
    size.shortestSide >= Breakpoints.tablet;

bool fitsSidePanel(Size size) =>
    size.width >= Breakpoints.sidePanel &&
    size.shortestSide >= Breakpoints.tablet;
