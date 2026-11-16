// 工具页的公共部分（docs/mobile-app.md §8.4，照网页版 features/tools/common.tsx）：
// 顶栏居中的小标题是工具名，返回 / 刷新是圆钮；内容区顶部大标题（项目名或文件夹名）+ 一行浅色小字；加载、出错、提示条。
// 工具在哪打开由 ToolHost 决定：手机上整页推进去，平板宽屏时放在会话右边一栏（A4c）。
import 'package:material_ui/material_ui.dart';

import '../../data/tasks.dart';
import '../../i18n/i18n.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';

/// 一个工具页要知道的：哪台电脑、哪个项目；打开会话、新建会话交回给打开它的地方（右边栏里也要在主区打开）
class ToolContext {
  const ToolContext({
    required this.deviceId,
    required this.project,
    required this.openSession,
    required this.newSession,
  });
  final String deviceId;
  final Project project;
  final void Function(String sessionId) openSession;

  /// 在项目里新建会话，输入框里先放好 draft
  final void Function(String projectId, String draft) newSession;
}

/// 工具页的框：小标题 + 刷新；body 是滚动内容（大标题已经放好），footer 固定在底部
class ToolFrame extends StatelessWidget {
  const ToolFrame({
    super.key,
    required this.title,
    this.subtitle,
    this.heading,
    this.crumb,
    this.loading = false,
    this.onRefresh,
    this.actions = const [],
    required this.children,
    this.footer,
  });
  final String title;
  final String? subtitle;

  /// 内容区的大标题（项目名、文件夹名）；为 null 时不画
  final String? heading;

  /// 大标题下面一行（分支、路径）
  final Widget? crumb;
  final bool loading;
  final VoidCallback? onRefresh;
  final List<Widget> actions;
  final List<Widget> children;
  final Widget? footer;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return AppScreen(
      title: title,
      subtitle: subtitle,
      leading: RoundIconButton(
        icon: Icons.arrow_back,
        tooltip: L('返回', 'Back'),
        onPressed: () => toolBack(context),
      ),
      trailing: [
        ...actions,
        if (onRefresh != null)
          loading
              ? const SizedBox.square(
                  dimension: 44,
                  child: Center(
                    child: SizedBox.square(
                      dimension: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                )
              : RoundIconButton(
                  icon: Icons.refresh,
                  tooltip: L('刷新', 'Refresh'),
                  onPressed: onRefresh,
                ),
      ],
      body: RefreshIndicator(
        onRefresh: () async => onRefresh?.call(),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
          children: [
            if (heading != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
                child: Text(
                  heading!,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: Fs.title,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -0.56,
                    color: c.text,
                  ),
                ),
              ),
            if (crumb != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
                child: DefaultTextStyle.merge(
                  style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                  child: crumb!,
                ),
              ),
            const SizedBox(height: 12),
            ...children,
          ],
        ),
      ),
      bottom: footer,
    );
  }
}

/// 还没取到：转圈；出错时显示错误
class ToolLoading extends StatelessWidget {
  const ToolLoading({super.key, this.error});
  final String? error;
  @override
  Widget build(BuildContext context) {
    if (error != null) return ToolBanner(error!, tone: Tone.danger);
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 64),
      child: Center(
        child: SizedBox.square(
          dimension: 22,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      ),
    );
  }
}

/// 提示条：出错（红）、提醒（橙）、普通（灰）
class ToolBanner extends StatelessWidget {
  const ToolBanner(this.text, {super.key, this.tone});
  final String text;
  final Tone? tone;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final color = switch (tone) {
      Tone.danger => c.danger,
      Tone.warn => c.warn,
      _ => c.textSecondary,
    };
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: tone == null ? c.bgSubtle : color.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(Radii.card),
      ),
      child: Text(
        text,
        style: TextStyle(fontSize: Fs.list, height: 1.5, color: color),
      ),
    );
  }
}

/// 分组标题：「已暂存 3」+ 右边一个文字按钮
class GroupTitle extends StatelessWidget {
  const GroupTitle(this.title, {super.key, this.count, this.action});
  final String title;
  final int? count;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 4, 6),
      child: Row(
        children: [
          Text(
            title,
            style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
          ),
          if (count != null) ...[
            const SizedBox(width: 6),
            Text(
              '$count',
              style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
            ),
          ],
          const Spacer(),
          ?action,
        ],
      ),
    );
  }
}

/// 灰底圆角分组（没有标题，标题用 GroupTitle 自己放）
class Group extends StatelessWidget {
  const Group({super.key, required this.children});
  final List<Widget> children;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(Radii.card),
        child: ColoredBox(
          color: c.bgSubtle,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
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
    );
  }
}

/// 页脚的小字说明
class ToolNote extends StatelessWidget {
  const ToolNote(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
    child: Text(
      text,
      style: TextStyle(fontSize: Fs.label, color: context.colors.textFaint),
    ),
  );
}

/// 增删行数「+3 −1」
class LineStat extends StatelessWidget {
  const LineStat(this.added, this.removed, {super.key});
  final int added;
  final int? removed;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '+$added',
            style: TextStyle(color: c.success),
          ),
          const TextSpan(text: ' '),
          TextSpan(
            text: '−${removed ?? 0}',
            style: TextStyle(color: c.danger),
          ),
        ],
      ),
      style: const TextStyle(fontSize: Fs.meta, fontFamily: 'monospace'),
    );
  }
}

/// 宽屏会话页的右边栏：给了就在这里打开工具（A4c）
class ToolHost extends InheritedWidget {
  const ToolHost({
    super.key,
    required this.show,
    required this.close,
    required super.child,
  });

  /// 在右边栏打开这一页（栏里有自己的导航，子页面也在栏里）；窄屏时为 null，整页推进去
  final void Function(Widget page)? show;

  /// 关掉右边栏
  final VoidCallback close;

  static ToolHost? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ToolHost>();

  @override
  bool updateShouldNotify(ToolHost old) =>
      old.show != show || old.close != close;
}

/// 工具页的返回：能退就退一页；在右边栏的第一页时关掉右边栏
void toolBack(BuildContext context) {
  final nav = Navigator.of(context);
  if (nav.canPop()) {
    nav.pop();
    return;
  }
  final host = ToolHost.maybeOf(context);
  if (host != null) {
    host.close();
  } else {
    nav.maybePop();
  }
}
