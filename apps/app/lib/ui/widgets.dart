// 通用组件（照网页版第四轮的样子，docs/mobile-remote.md §26）：浮动圆钮顶栏、圆形按钮、分组列表、底部大圆角面板。
import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';

import 'layout.dart';
import 'theme/theme.dart';
import 'theme/tokens.dart';
import 'theme/type.dart';

/// 圆形图标按钮（顶栏 ☰ ⋯、返回、新建）：40 圆，点按区域 44
class RoundIconButton extends StatelessWidget {
  const RoundIconButton({
    super.key,
    required this.icon,
    required this.onPressed,
    required this.tooltip,
    this.filled = true,
    this.size = 40,
  });
  final IconData icon;
  final VoidCallback? onPressed;
  final String tooltip;
  final bool filled;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        label: tooltip,
        child: SizedBox.square(
          dimension: 44,
          child: Center(
            child: Material(
              color: filled ? c.bgSurface : Colors.transparent,
              shape: CircleBorder(
                side: filled
                    ? BorderSide(color: c.borderCard)
                    : BorderSide.none,
              ),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: onPressed,
                child: SizedBox.square(
                  dimension: size,
                  child: Icon(icon, size: 20, color: c.text),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 页面：浮动顶栏（实底盖住刘海、下沿渐隐）+ 居中标题；leading / trailing 放圆钮
class AppScreen extends StatefulWidget {
  const AppScreen({
    super.key,
    this.title,
    this.subtitle,
    this.leading,
    this.trailing = const [],
    required this.body,
    this.bottom,
    this.drawer,
    this.center,
    this.side,
  });
  final String? title;
  final String? subtitle;
  final Widget? leading;
  final List<Widget> trailing;
  final Widget body;

  /// 浮在底部的东西（输入框、审批卡）
  final Widget? bottom;

  /// 左侧抽屉（首页、会话页）。宽 ≥ 900 时常驻左边，这时不画 leading（那里放的是 ☰）
  final Widget? drawer;

  /// 顶栏中间换成自己的（会话页的标题胶囊、模型胶囊）；给了就不画 title / subtitle
  final Widget? center;

  /// 右边一栏（宽屏时会话页打开的工具），给了就排在内容右边
  final Widget? side;

  @override
  State<AppScreen> createState() => _AppScreenState();
}

class _AppScreenState extends State<AppScreen> {
  final _scaffold = GlobalKey<ScaffoldState>();
  bool _drawerOpen = false;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final AppScreen(
      :title,
      :subtitle,
      :leading,
      :trailing,
      :body,
      :bottom,
      :drawer,
      :center,
      :side,
    ) = widget;
    final pinned = drawer != null && drawerPinned(context);
    // 宽屏时内容限宽居中（对话、列表读起来不会一行太长）
    Widget limit(Widget child) => Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: PaneWidth.content),
        child: child,
      ),
    );
    final top = MediaQuery.paddingOf(context).top;
    const barHeight = 56.0;
    final bar = Container(
      padding: EdgeInsets.only(top: top, left: 8, right: 8),
      height: top + barHeight,
      decoration: BoxDecoration(color: c.bgWorkbench),
      child: Row(
        children: [
          if (leading != null && !pinned)
            leading
          else
            const SizedBox(width: 44),
          Expanded(
            child:
                center ??
                Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (title != null)
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: Fs.ui,
                          fontWeight: FontWeight.w600,
                          color: c.text,
                        ),
                      ),
                    if (subtitle != null)
                      Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                      ),
                  ],
                ),
          ),
          if (trailing.isEmpty) const SizedBox(width: 44) else ...trailing,
        ],
      ),
    );
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: Theme.of(context).brightness == Brightness.dark
          ? SystemUiOverlayStyle.light
          : SystemUiOverlayStyle.dark,
      // 抽屉开着时返回只关抽屉。安卓 16 的预测返回下（模拟器实测：冷启动后从屏幕边缘滑动返回），
      // 不拦的话抽屉开着也会直接退出 App
      child: PopScope(
        canPop: !_drawerOpen,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop) _scaffold.currentState?.closeDrawer();
        },
        child: Scaffold(
          key: _scaffold,
          backgroundColor: c.bgWorkbench,
          drawer: pinned ? null : drawer,
          drawerScrimColor: c.scrim,
          onDrawerChanged: (open) => setState(() => _drawerOpen = open),
          body: _panes(
            context,
            pinned ? drawer : null,
            side,
            Stack(
              children: [
                // 底部的输入框、审批卡排在内容下面（不盖住最后几行）；键盘弹出时整页一起上移
                Positioned.fill(
                  child: Padding(
                    padding: EdgeInsets.only(top: top + barHeight),
                    child: bottom == null
                        ? limit(body)
                        : Column(
                            children: [
                              Expanded(child: limit(body)),
                              // 让开系统手势条 / Home 指示条（键盘弹出时 padding 自己变成 0）
                              Padding(
                                padding: EdgeInsets.only(
                                  bottom: MediaQuery.paddingOf(context).bottom,
                                ),
                                child: limit(bottom),
                              ),
                            ],
                          ),
                  ),
                ),
                Positioned(top: 0, left: 0, right: 0, child: bar),
                // 顶栏下沿 20 渐隐：内容滚上去时不是一刀切
                Positioned(
                  top: top + barHeight,
                  left: 0,
                  right: 0,
                  height: 20,
                  child: IgnorePointer(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [
                            c.bgWorkbench,
                            c.bgWorkbench.withValues(alpha: 0),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// 宽屏：常驻的抽屉 | 内容 | 右边栏，中间细线隔开
  Widget _panes(
    BuildContext context,
    Widget? drawer,
    Widget? side,
    Widget main,
  ) {
    if (drawer == null && side == null) return main;
    final c = context.colors;
    final line = VerticalDivider(width: 1, thickness: 1, color: c.borderSubtle);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (drawer != null) ...[
          SizedBox(width: PaneWidth.drawer, child: drawer),
          line,
        ],
        Expanded(child: main),
        if (side != null) ...[
          line,
          SizedBox(width: PaneWidth.side, child: side),
        ],
      ],
    );
  }
}

/// 深色圆角主按钮（48 高）
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.busy = false,
  });
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SizedBox(
      height: 48,
      width: double.infinity,
      child: FilledButton(
        style: FilledButton.styleFrom(
          backgroundColor: c.btnPrimaryBg,
          foregroundColor: c.btnPrimaryText,
          disabledBackgroundColor: c.bgSelected,
          shape: const StadiumBorder(),
          textStyle: const TextStyle(
            fontSize: Fs.prose,
            fontWeight: FontWeight.w600,
          ),
        ),
        onPressed: busy ? null : onPressed,
        child: busy
            ? SizedBox.square(
                dimension: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: c.textMuted,
                ),
              )
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (icon != null) ...[
                    Icon(icon, size: 20),
                    const SizedBox(width: 8),
                  ],
                  Text(label),
                ],
              ),
      ),
    );
  }
}

/// 浅色描边的次按钮（48 高）
class SecondaryButton extends StatelessWidget {
  const SecondaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
  });
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SizedBox(
      height: 48,
      width: double.infinity,
      child: OutlinedButton(
        style: OutlinedButton.styleFrom(
          foregroundColor: c.text,
          side: BorderSide(color: c.borderCard),
          shape: const StadiumBorder(),
          textStyle: const TextStyle(
            fontSize: Fs.prose,
            fontWeight: FontWeight.w500,
          ),
        ),
        onPressed: onPressed,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: 20),
              const SizedBox(width: 8),
            ],
            Text(label),
          ],
        ),
      ),
    );
  }
}

/// 灰底圆角分组（iOS 分组列表，不描边）
class Section extends StatelessWidget {
  const Section({super.key, this.title, required this.children});
  final String? title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (title != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 6),
            child: Text(
              title!,
              style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
            ),
          ),
        ClipRRect(
          borderRadius: BorderRadius.circular(Radii.card),
          child: ColoredBox(
            color: c.bgSubtle,
            child: Column(
              children: [
                for (var i = 0; i < children.length; i++) ...[
                  if (i > 0)
                    Divider(height: 1, indent: 16, color: c.borderSubtle),
                  children[i],
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// 分组里的一行
class ListRow extends StatelessWidget {
  const ListRow({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onTap,
    this.danger = false,
  });
  final String title;
  final String? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 48),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(
            children: [
              if (leading != null) ...[leading!, const SizedBox(width: 12)],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: Fs.prose,
                        color: danger ? c.danger : c.text,
                      ),
                    ),
                    if (subtitle != null)
                      Text(
                        subtitle!,
                        style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                      ),
                  ],
                ),
              ),
              ?trailing,
              if (onTap != null && trailing == null)
                Icon(Icons.chevron_right, color: c.textFaint),
            ],
          ),
        ),
      ),
    );
  }
}

/// 底部大圆角面板（顶上有拖动条）
Future<T?> showPanel<T>(BuildContext context, WidgetBuilder builder) =>
    showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: builder(context),
      ),
    );

/// 页面中间的空状态 / 说明
class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.body,
    this.action,
  });
  final IconData icon;
  final String title;
  final String? body;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: c.textFaint),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: Fs.section,
                fontWeight: FontWeight.w600,
                color: c.text,
              ),
            ),
            if (body != null) ...[
              const SizedBox(height: 6),
              Text(
                body!,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: Fs.list,
                  color: c.textMuted,
                  height: 1.5,
                ),
              ),
            ],
            if (action != null) ...[const SizedBox(height: 20), action!],
          ],
        ),
      ),
    );
  }
}
