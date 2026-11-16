// 浅色 / 深色主题：圆角、字号照网页版第四轮（docs/mobile-remote.md §26：卡片 16、面板 30、按钮全圆，正文 16）
import 'package:material_ui/material_ui.dart';

import 'tokens.dart';

abstract final class Radii {
  static const card = 16.0;
  static const panel = 30.0;
  static const bubble = 20.0;
  static const composer = 22.0;

  /// 回复里的代码块
  static const code = 12.0;
}

ThemeData buildTheme(Brightness brightness) {
  final c = brightness == Brightness.dark ? AppColors.dark : AppColors.light;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: c.accent,
    onPrimary: c.accentOn,
    secondary: c.accent,
    onSecondary: c.accentOn,
    error: c.danger,
    onError: c.bgSurface,
    surface: c.bgWorkbench,
    onSurface: c.text,
    surfaceContainerHighest: c.bgSubtle,
    outline: c.border,
    outlineVariant: c.borderSubtle,
  );
  final base = ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: c.bgWorkbench,
    splashFactory: InkSparkle.splashFactory,
    extensions: [c],
    dividerColor: c.borderSubtle,
  );
  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: c.text, displayColor: c.text),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: c.accent,
      selectionColor: c.accent.withValues(alpha: 0.25),
      selectionHandleColor: c.accent,
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: c.bgPopover,
      showDragHandle: true,
      dragHandleColor: c.textFaint,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Radii.panel)),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: c.btnPrimaryBg,
      contentTextStyle: TextStyle(color: c.btnPrimaryText),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Radii.card),
      ),
    ),
  );
}
