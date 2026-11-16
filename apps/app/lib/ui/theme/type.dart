// 字号七级和间距（docs/mobile-app.md §8.3）：照设计变量的七级字号（docs/ui/design-tokens.md §2）× 1.05，
// 和网页版手机端（apps/mobile 的 --font-scale）一样大。组件里只用这里的字号，不写别的数。
import 'package:material_ui/material_ui.dart';

abstract final class Fs {
  /// 页面大标题（概览「会话」、抽屉、添加电脑）
  static const title = 28.0;

  /// 卡片、面板、区块标题；空状态标题
  static const section = 17.0;

  /// 对话正文、你的消息、输入框
  static const prose = 15.0;

  /// 列表行标题、按钮、菜单项、顶栏标题
  static const ui = 14.0;

  /// 步骤行、次要正文、说明
  static const list = 13.5;

  /// 副标题、时间、状态、脚注
  static const meta = 12.5;

  /// 分组小标题、徽章、代码语言
  static const label = 11.5;
}

/// 行高
abstract final class Lh {
  static const prose = 1.6;
  static const ui = 1.4;
}

/// 间距四档：页边 16，卡片里 12
abstract final class Gap {
  static const xs = 4.0;
  static const s = 8.0;
  static const m = 12.0;
  static const l = 16.0;
}

/// 跟随系统字体大小，最多放大到 1.3 倍（同网页版 90%–130%），免得顶栏、胶囊挤爆
const maxTextScale = 1.3;

/// 包在 App 外面：把系统字体倍数限制在 maxTextScale 以内
Widget clampTextScale(BuildContext context, Widget child) => MediaQuery(
  data: MediaQuery.of(context).copyWith(
    textScaler: MediaQuery.textScalerOf(context)
        .clamp(maxScaleFactor: maxTextScale),
  ),
  child: child,
);
