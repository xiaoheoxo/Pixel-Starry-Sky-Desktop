// 颜色变量：取自网页版 apps/mobile/src/styles/tokens.css（和 docs/ui/design-tokens.md 同一套），浅色、深色两套。
// 界面只用这里的颜色，不在组件里写死色值。color-mix(ink N%, transparent) 写成 ink 加透明度。
import 'package:material_ui/material_ui.dart';

@immutable
class AppColors extends ThemeExtension<AppColors> {
  const AppColors({
    required this.ink,
    required this.bgApp,
    required this.bgWorkbench,
    required this.bgSurface,
    required this.bgPopover,
    required this.bgSidebar,
    required this.bgSubtle,
    required this.bgHover,
    required this.bgSelected,
    required this.border,
    required this.borderSubtle,
    required this.borderCard,
    required this.borderComposer,
    required this.text,
    required this.textBody,
    required this.textSecondary,
    required this.textMuted,
    required this.textFaint,
    required this.accent,
    required this.accentOn,
    required this.accentSoft,
    required this.accentText,
    required this.statusOnline,
    required this.success,
    required this.danger,
    required this.warn,
    required this.notify,
    required this.btnPrimaryBg,
    required this.btnPrimaryText,
    required this.engineClaude,
    required this.ultracode,
    required this.codeInlineText,
    required this.codeInlineBg,
    required this.codePath,
    required this.synComment,
    required this.synKeyword,
    required this.synString,
    required this.synNumber,
    required this.synFunc,
    required this.synType,
    required this.synMeta,
    required this.avatarBg,
    required this.avatarText,
    required this.scrim,
  });

  final Color ink;
  final Color bgApp;

  /// 会话页和抽屉的底（白 / 深灰）
  final Color bgWorkbench;
  final Color bgSurface;
  final Color bgPopover;
  final Color bgSidebar;
  final Color bgSubtle;
  final Color bgHover;
  final Color bgSelected;
  final Color border;
  final Color borderSubtle;
  final Color borderCard;
  final Color borderComposer;
  final Color text;
  final Color textBody;
  final Color textSecondary;
  final Color textMuted;
  final Color textFaint;
  final Color accent;
  final Color accentOn;
  final Color accentSoft;
  final Color accentText;
  final Color statusOnline;
  final Color success;
  final Color danger;
  final Color warn;
  final Color notify;
  final Color btnPrimaryBg;
  final Color btnPrimaryText;
  final Color engineClaude;
  final Color ultracode;
  final Color codeInlineText;
  final Color codeInlineBg;
  final Color codePath;
  final Color synComment;
  final Color synKeyword;
  final Color synString;
  final Color synNumber;
  final Color synFunc;
  final Color synType;
  final Color synMeta;
  final Color avatarBg;
  final Color avatarText;
  final Color scrim;

  static Color _mix(Color ink, double percent) =>
      ink.withValues(alpha: percent / 100);

  static final light = AppColors(
    ink: const Color(0xFF20211F),
    bgApp: const Color(0xFFF8F8F6),
    bgWorkbench: const Color(0xFFFFFFFF),
    bgSurface: const Color(0xFFFFFFFF),
    bgPopover: const Color(0xFFFFFFFF),
    bgSidebar: const Color(0xFFF2F2EF),
    bgSubtle: _mix(const Color(0xFF20211F), 4),
    bgHover: _mix(const Color(0xFF20211F), 4.5),
    bgSelected: _mix(const Color(0xFF20211F), 7),
    border: const Color(0xFFE2E2DC),
    borderSubtle: const Color(0xFFEAEAE5),
    borderCard: _mix(const Color(0xFF20211F), 10),
    borderComposer: _mix(const Color(0xFF20211F), 12),
    text: const Color(0xFF20211F),
    textBody: const Color(0xFF20211F),
    textSecondary: const Color(0xFF4A4C47),
    textMuted: const Color(0xFF777872),
    textFaint: const Color(0xFFA3A39B),
    accent: const Color(0xFF2D6151),
    accentOn: const Color(0xFFFFFFFF),
    accentSoft: const Color(0xFFE1EAE5),
    accentText: const Color(0xFF2D6151),
    statusOnline: const Color(0xFF4D8A75),
    success: const Color(0xFF2F7D4F),
    danger: const Color(0xFFB8463F),
    warn: const Color(0xFFB97A36),
    notify: const Color(0xFFD2483F),
    btnPrimaryBg: const Color(0xFF20211F),
    btnPrimaryText: const Color(0xFFFFFFFF),
    engineClaude: const Color(0xFFD97757),
    ultracode: const Color(0xFF7C3AED),
    codeInlineText: const Color(0xFFA8402F),
    codeInlineBg: const Color(0x12A8402F),
    codePath: const Color(0xFF3E6A5C),
    synComment: const Color(0xFF8B8A82),
    synKeyword: const Color(0xFF9B3F92),
    synString: const Color(0xFF3F7F3B),
    synNumber: const Color(0xFF9C6114),
    synFunc: const Color(0xFF2F62C4),
    synType: const Color(0xFF946A0E),
    synMeta: const Color(0xFF1B7A96),
    avatarBg: const Color(0xFFF0E2D6),
    avatarText: const Color(0xFF7A5A43),
    scrim: const Color(0x4720211F),
  );

  static final dark = AppColors(
    ink: const Color(0xFFFAF9F5),
    bgApp: const Color(0xFF1F1F1E),
    bgWorkbench: const Color(0xFF242422),
    bgSurface: const Color(0xFF262624),
    bgPopover: const Color(0xFF2E2E2B),
    bgSidebar: const Color(0xFF1A1A19),
    bgSubtle: _mix(const Color(0xFFFAF9F5), 5),
    bgHover: _mix(const Color(0xFFFAF9F5), 6),
    bgSelected: _mix(const Color(0xFFFAF9F5), 10),
    border: const Color(0xFF33332F),
    borderSubtle: const Color(0xFF2A2A28),
    borderCard: _mix(const Color(0xFFFAF9F5), 8),
    borderComposer: _mix(const Color(0xFFFAF9F5), 9),
    text: const Color(0xFFECEBE7),
    textBody: const Color(0xFFDCDAD3),
    textSecondary: const Color(0xFFC2C0B6),
    textMuted: const Color(0xFF9C9A92),
    textFaint: const Color(0xFF6E6C66),
    accent: const Color(0xFF7FC4A8),
    accentOn: const Color(0xFF13261E),
    accentSoft: const Color(0xFF1E3A30),
    accentText: const Color(0xFF8FD0B4),
    statusOnline: const Color(0xFF6FBF9C),
    success: const Color(0xFF6FCF97),
    danger: const Color(0xFFF0857D),
    warn: const Color(0xFFE0A86A),
    notify: const Color(0xFFF0675E),
    btnPrimaryBg: const Color(0xFFECEBE7),
    btnPrimaryText: const Color(0xFF1F1F1E),
    engineClaude: const Color(0xFFD97757),
    ultracode: const Color(0xFFA78BFA),
    codeInlineText: const Color(0xFFEC9A87),
    codeInlineBg: const Color(0x1AEC9A87),
    codePath: const Color(0xFF9CC7B5),
    synComment: const Color(0xFF84837C),
    synKeyword: const Color(0xFFC993DA),
    synString: const Color(0xFFA6C98D),
    synNumber: const Color(0xFFDBA579),
    synFunc: const Color(0xFF82B2EA),
    synType: const Color(0xFFE0C28D),
    synMeta: const Color(0xFF7CC3CD),
    avatarBg: const Color(0xFF3A3029),
    avatarText: const Color(0xFFE3C3A8),
    scrim: const Color(0x8C000000),
  );

  @override
  AppColors copyWith() => this;

  @override
  AppColors lerp(AppColors? other, double t) =>
      t < 0.5 || other == null ? this : other;
}

extension AppColorsOf on BuildContext {
  AppColors get colors => Theme.of(this).extension<AppColors>()!;
}
