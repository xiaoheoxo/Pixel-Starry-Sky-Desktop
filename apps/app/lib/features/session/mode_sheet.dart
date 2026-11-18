// 改模式的面板（规则照网页版 ModeChip.tsx / ui/ModeSheet.tsx）：几组单选（权限、模型、强度）加几个开关（快速模式、思考摘要）。
// 会话页顶栏的模型胶囊点开它；改了马上发给电脑（engine:updateSession），电脑推回来的会话记录变了面板跟着变。
// 往更宽的权限切确认一次；完全放行手机上开不了；快速模式打开时确认一次（按更高的价格计费）。
// 额度来源（docs/mobile-app.md §14.4）：只列电脑上配好的；换到平台、或换成更贵的线路时确认倍率。
// 新建对话页用同一个面板，只是改的是本地的选择（NewModeSheet）。
import 'package:material_ui/material_ui.dart';

import '../../data/quota.dart';
import '../account/quota_section.dart';
import '../../data/actions.dart';
import '../../data/mode.dart';
import '../../data/session_controller.dart';
import '../../data/sources.dart';
import '../../i18n/i18n.dart';
import '../../protocol/constants.dart';
import '../../protocol/json.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import 'approval_card.dart' show confirm;

class ModeGroup {
  const ModeGroup({
    required this.title,
    required this.options,
    required this.value,
    required this.onPick,
    this.segmented = false,
    this.toggle,
  });
  final String title;
  final List<ModeOption> options;
  final String value;
  final ValueChanged<String> onPick;

  /// 选项下面跟一个开关（权限下面的「先出计划」，docs/mobile-app.md §15.2）；只用在一行一项的组
  final ModeToggle? toggle;

  /// 选项不多、没有说明时画成一排分段按钮（强度）
  final bool segmented;
}

class ModeToggle {
  const ModeToggle({
    required this.label,
    required this.value,
    required this.onChanged,
    this.hint,
    this.warn = false,
    this.disabled = false,
    this.icon,
  });
  final String label;
  final String? hint;
  final bool warn;
  final bool disabled;
  final IconData? icon;
  final bool value;
  final ValueChanged<bool> onChanged;
}

/// 只管画：选项和规则由调用方算好
class ModePanel extends StatelessWidget {
  const ModePanel({
    super.key,
    required this.title,
    required this.groups,
    this.toggles = const [],
    this.note,
    this.error,
    this.busy = false,
    this.readOnly = false,
    this.header,
  });
  final String title;

  /// 标题下面的一行（会话的额度简写，§17）
  final Widget? header;
  final List<ModeGroup> groups;
  final List<ModeToggle> toggles;
  final String? note;
  final String? error;
  final bool busy;
  final bool readOnly;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final locked = busy || readOnly;
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.85,
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        children: [
          Row(
            children: [
              Text(
                title,
                style: TextStyle(
                  fontSize: Fs.section,
                  fontWeight: FontWeight.w600,
                  color: c.text,
                ),
              ),
              if (busy) ...[
                const SizedBox(width: 10),
                SizedBox.square(
                  dimension: 14,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.5,
                    color: c.textMuted,
                  ),
                ),
              ],
            ],
          ),
          ?header,
          for (final g in groups) ...[
            Padding(
              padding: const EdgeInsets.only(top: 18, bottom: 6),
              child: Text(
                g.title,
                style: TextStyle(
                  fontSize: Fs.meta,
                  fontWeight: FontWeight.w600,
                  color: c.textMuted,
                ),
              ),
            ),
            if (g.segmented &&
                g.options.length <= 6 &&
                !g.options.any((o) => o.hint != null || o.disabled))
              Opacity(
                opacity: locked ? 0.5 : 1,
                child: SizedBox(
                  width: double.infinity,
                  child: SegmentedButton<String>(
                    showSelectedIcon: false,
                    style: SegmentedButton.styleFrom(
                      backgroundColor: Colors.transparent,
                      foregroundColor: c.textMuted,
                      selectedBackgroundColor: c.bgSelected,
                      selectedForegroundColor: c.text,
                      side: BorderSide(color: c.borderSubtle),
                      visualDensity: VisualDensity.compact,
                      textStyle: const TextStyle(
                        fontSize: Fs.ui,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    segments: [
                      for (final o in g.options)
                        ButtonSegment(
                          value: o.value,
                          label: Text(o.label, maxLines: 1),
                        ),
                    ],
                    selected: {g.value},
                    onSelectionChanged: locked
                        ? null
                        : (v) {
                            if (v.first != g.value) g.onPick(v.first);
                          },
                  ),
                ),
              )
            // 档位多（推理强度 7 档）：一排小胶囊，放不下自动换行，不再一档占一整行
            else if (g.segmented &&
                !g.options.any((o) => o.hint != null || o.disabled))
              Opacity(
                opacity: locked ? 0.5 : 1,
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final o in g.options)
                      _Pill(
                        label: o.label,
                        selected: o.value == g.value,
                        onTap: locked || o.value == g.value
                            ? null
                            : () => g.onPick(o.value),
                      ),
                  ],
                ),
              )
            else
              // Material 当底色：组里跟着的开关行，点按水波画在它上面
              Material(
                color: c.bgSubtle,
                borderRadius: BorderRadius.circular(16),
                clipBehavior: Clip.antiAlias,
                child: Column(
                  children: [
                    for (var i = 0; i < g.options.length; i++) ...[
                      if (i > 0)
                        Divider(height: 1, indent: 16, color: c.borderSubtle),
                      _OptionRow(
                        option: g.options[i],
                        selected: g.options[i].value == g.value,
                        enabled:
                            !g.options[i].disabled &&
                            !(locked && g.options[i].value != g.value),
                        onTap: () {
                          if (g.options[i].value != g.value) {
                            g.onPick(g.options[i].value);
                          }
                        },
                      ),
                    ],
                    if (g.toggle != null) ...[
                      Divider(height: 1, color: c.borderSubtle),
                      _toggleTile(g.toggle!, locked, c),
                    ],
                  ],
                ),
              ),
          ],
          if (toggles.isNotEmpty) ...[
            const SizedBox(height: 18),
            // 用 Material 当底色：开关行的点按水波画在它上面（Container 的底色会把水波盖住）
            Material(
              color: c.bgSubtle,
              borderRadius: BorderRadius.circular(16),
              clipBehavior: Clip.antiAlias,
              child: Column(
                children: [
                  for (var i = 0; i < toggles.length; i++) ...[
                    if (i > 0)
                      Divider(height: 1, indent: 16, color: c.borderSubtle),
                    _toggleTile(toggles[i], locked, c),
                  ],
                ],
              ),
            ),
          ],
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(top: 14),
              child: Text(
                error!,
                style: TextStyle(fontSize: Fs.meta, color: c.danger),
              ),
            ),
          if (note != null && note!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(
                note!,
                style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
              ),
            ),
        ],
      ),
    );
  }
}

/// 一档：选中实底（bg-selected），没选的描边
/// 开关的一行（面板底部的开关组、组里跟着的开关共用）
Widget _toggleTile(ModeToggle t, bool locked, AppColors c) => Opacity(
  opacity: locked || t.disabled ? 0.5 : 1,
  child: SwitchListTile(
    value: t.value,
    onChanged: locked || t.disabled ? null : t.onChanged,
    title: Row(
      children: [
        if (t.icon != null) ...[
          Icon(t.icon, size: 16, color: c.warn),
          const SizedBox(width: 6),
        ],
        Text(
          t.label,
          style: TextStyle(fontSize: Fs.ui, color: c.text),
        ),
      ],
    ),
    subtitle: t.hint == null
        ? null
        : Text(
            t.hint!,
            style: TextStyle(
              fontSize: Fs.meta,
              color: t.warn ? c.warn : c.textMuted,
            ),
          ),
  ),
);

class _Pill extends StatelessWidget {
  const _Pill({required this.label, required this.selected, this.onTap});
  final String label;
  final bool selected;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Material(
      color: selected ? c.bgSelected : Colors.transparent,
      shape: StadiumBorder(
        side: BorderSide(color: selected ? c.borderCard : c.borderSubtle),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Text(
            label,
            style: TextStyle(
              fontSize: Fs.ui,
              fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
              color: selected ? c.text : c.textSecondary,
            ),
          ),
        ),
      ),
    );
  }
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({
    required this.option,
    required this.selected,
    required this.enabled,
    required this.onTap,
  });
  final ModeOption option;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Opacity(
      opacity: enabled || selected ? 1 : 0.5,
      child: InkWell(
        onTap: enabled ? onTap : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        option.label,
                        style: TextStyle(
                          fontSize: Fs.ui,
                          color: c.text,
                          fontWeight: selected
                              ? FontWeight.w600
                              : FontWeight.w400,
                        ),
                      ),
                      if (option.hint != null)
                        Text(
                          option.hint!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: Fs.meta,
                            color: c.textMuted,
                          ),
                        ),
                    ],
                  ),
                ),
                if (selected) Icon(Icons.check, size: 20, color: c.accentText),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 会话的模式面板：跟着会话记录变；改了马上发给电脑
class SessionModeSheet extends StatefulWidget {
  const SessionModeSheet({
    super.key,
    required this.session,
    required this.actions,
    required this.desktop,
  });
  final SessionController session;
  final SessionActions actions;
  final DesktopActions desktop;

  @override
  State<SessionModeSheet> createState() => _SessionModeSheetState();
}

class _SessionModeSheetState extends State<SessionModeSheet> {
  bool _busy = false;
  String? _error;
  List<EngineModel>? _models;
  bool _unsupported = false;
  String? _engineLoaded;

  /// 电脑上配好的来源；旧电脑、读不到时为 null（不显示来源那组）
  PhoneSources? _sources;
  String? _sourcesEngine;

  void _loadSources(String engine) {
    if (_sourcesEngine == engine) return;
    _sourcesEngine = engine;
    _sources = null;
    widget.desktop.sources(engine).then((s) {
      if (mounted) setState(() => _sources = s);
    }, onError: (Object _) {});
  }

  Json get _record => obj(widget.session.view.snapshot?['record']);

  void _loadCatalog(String engine) {
    if (_engineLoaded == engine) return;
    _engineLoaded = engine;
    _models = null;
    widget.desktop
        .catalog(engine)
        .then(
          (m) {
            if (mounted) setState(() => _models = m);
          },
          onError: (Object e) {
            if (mounted) {
              setState(() {
                _models = const [];
                _unsupported = '$e' == 'MOBILE_UNSUPPORTED';
              });
            }
          },
        );
  }

  Future<void> _apply(Json patch) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.actions.update(patch);
    } catch (e) {
      if (mounted) setState(() => _error = actionError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.session,
      builder: (context, _) {
        final record = _record;
        final engine =
            str(record['nextEngine']) ?? str(record['engine']) ?? 'claude';
        final custom = truthy(record['provider']);
        if (!custom) _loadCatalog(engine);
        _loadSources(engine);
        final sources = _sources;
        // 平台 / 自定义接口的会话：模型来自那条线路 / 那个接口
        final viaSource = custom || truthy(record['platform']);
        final sourceList = viaSource ? sourceModels(sources, record) : null;
        final caps = engines[engine];
        // 额度简写（§17）：平台线路的会话看平台额度，自定义接口没有额度，其余看引擎的订阅账号
        final quotaProvider = custom
            ? null
            : truthy(record['platform'])
            ? 'platform'
            : engineQuotaProvider(engine);
        final model = str(record['model']);
        final effort = str(record['effort']);
        final permission = str(record['permissionMode']);
        // 计划中：档位那组显示、改的是批准后回到哪一档
        final planning = inPlan(record);
        final level = planning ? planReturnOf(record) : permission;
        EngineModel? current;
        for (final m in _models ?? const <EngineModel>[]) {
          if (m.id == model) current = m;
        }
        final flags = objOrNull(widget.session.view.snapshot?['flags']);
        final fast = fastStatus(flags);
        final canAct = widget.actions.canAct;
        return ModePanel(
          title: L('这个会话的模式', 'Conversation mode'),
          header: quotaProvider == null
              ? null
              : QuotaLine(
                  key: ValueKey(quotaProvider),
                  deviceId: widget.desktop.deviceId,
                  provider: quotaProvider,
                ),
          busy: _busy,
          readOnly: !canAct || _unsupported,
          error:
              _error ??
              (_unsupported
                  ? L(
                      '电脑上的像素星空版本较旧，手机还不能改模式。',
                      "The computer's PixelSky is out of date, so the phone can't change modes yet.",
                    )
                  : !canAct
                  ? L(
                      '没连上电脑，或这部手机是「只看」。',
                      'Not connected, or this phone is “View only”.',
                    )
                  : null),
          note: [
            if (caps != null && !caps.liveModelSwitch)
              L(
                '模型和强度下一轮生效。',
                'Model and effort changes apply from the next turn.',
              ),
            if (caps != null && !caps.livePermissionSwitch)
              L(
                '正在运行时改权限，下一轮生效。',
                'Permission changes while running apply from the next turn.',
              ),
            if (sources != null &&
                sources.platform == null &&
                sources.platformError != null)
              L(
                '平台线路现在用不了：${sources.platformError}。',
                'Platform routes are unavailable: ${sources.platformError}. ',
              ),
            caps?.fast == true
                ? L(
                    '换模型、调高强度、打开快速模式会改变费用。',
                    'Changing the model, raising effort, or Fast mode changes the cost.',
                  )
                : L(
                    '换模型、调高强度会改变费用。',
                    'Changing the model or raising effort changes the cost.',
                  ),
          ].join(L('', ' ')),
          groups: [
            if (sources != null)
              ModeGroup(
                title: L('额度来源', 'Quota source'),
                options: sourceOptions(sources, record),
                value: sourceKey(record),
                onPick: (v) async {
                  final ask = sourceConfirm(sources, record, v);
                  if (ask != null && !await confirm(context, ask)) return;
                  await _apply(sourcePatch(v));
                },
              ),
            ModeGroup(
              title: L('权限', 'Permissions'),
              options: permissionOptions(engine, level),
              value: level ?? '',
              onPick: (v) async {
                if (widens(level, v) &&
                    !await confirm(context, widenConfirm())) {
                  return;
                }
                await _apply(
                  planning ? {'planReturn': v} : {'permissionMode': v},
                );
              },
              toggle: (caps?.permissionModes.contains('plan') ?? false)
                  ? ModeToggle(
                      label: L('先出计划', 'Plan first'),
                      hint: planning
                          ? planAfterText(record)
                          : L(
                              '只读代码、写计划，你批准后再动手',
                              'Reads code and writes a plan; changes start after you approve',
                            ),
                      value: planning,
                      onChanged: (v) => _apply(
                        v
                            ? {'permissionMode': 'plan'}
                            : {
                                'permissionMode': planOffMode(
                                  planReturnOf(record),
                                ),
                              },
                      ),
                    )
                  : null,
            ),
            ModeGroup(
              title: sourceList != null
                  ? L('模型', 'Model')
                  : custom
                  ? L(
                      '模型（自定义接口的，在电脑上改）',
                      'Model (custom endpoint, change it on the computer)',
                    )
                  : _models == null
                  ? L('模型（正在取）', 'Model (loading)')
                  : L('模型', 'Model'),
              options: sourceList != null
                  ? [for (final m in sourceList) ModeOption(m, modelLabel(m))]
                  : custom
                  ? [
                      ModeOption(
                        model ?? '',
                        model != null ? modelLabel(model) : L('默认', 'Default'),
                      ),
                    ]
                  : modelOptions(_models, model),
              value: model ?? '',
              onPick: (v) {
                // 线路 / 接口的模型由电脑对着那份列表核对；接口没列模型时在电脑上改
                if (sourceList == null && custom) return;
                // 新模型不支持现在的强度：一起退回默认（线路上的模型在引擎目录里查得到时也一样）
                EngineModel? next;
                for (final m in _models ?? const <EngineModel>[]) {
                  if (m.id == v) next = m;
                }
                final drop =
                    effort != null &&
                    next != null &&
                    next.efforts.isNotEmpty &&
                    !next.efforts.contains(effort);
                _apply({
                  'model': v.isEmpty ? null : v,
                  if (drop) 'effort': null,
                });
              },
            ),
            ModeGroup(
              title: L('推理强度', 'Reasoning effort'),
              options: effortOptions(engine, current, effort),
              value: effort ?? '',
              segmented: true,
              onPick: (v) => _apply({'effort': v.isEmpty ? null : v}),
            ),
          ],
          toggles: [
            if (caps?.fast == true)
              ModeToggle(
                label: L('快速模式', 'Fast mode'),
                icon: Icons.bolt,
                hint: fast.hint,
                warn: fast.warn,
                disabled: !fast.available && record['fast'] != true,
                value: record['fast'] == true,
                onChanged: (v) async {
                  if (v && !await confirm(context, fastConfirm())) return;
                  await _apply({'fast': v});
                },
              ),
            if (caps?.thinkingSummaries == true)
              ModeToggle(
                label: L('显示思考摘要', 'Show thinking summaries'),
                value: record['thinkingSummaries'] == true,
                onChanged: (v) => _apply({'thinkingSummaries': v}),
              ),
          ],
        );
      },
    );
  }
}

/// 顶栏的模型胶囊上写什么：「Sonnet 4.5 · 高」，没指定写「默认模型」；开着快速模式时带 ⚡
String modelChipText(Json record) {
  final chip = modeChip(record);
  final parts = [?chip.model, ?chip.effort];
  return parts.isEmpty ? L('默认模型', 'Default model') : parts.join(' · ');
}
