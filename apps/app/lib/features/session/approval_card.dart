// 审批 / 提问卡片：顶替输入框位置的浮动圆角卡片，大圆按钮（规则照网页版 ApprovalCard.tsx）。
// 「总是允许」在手机上多问一次；提问：推荐项、「都按推荐」、自己填答案、密码类的题用密码框；
// 要填表单的请求手机上只能拒绝或回电脑处理。没送到电脑时卡片还在，写明没处理成。
import 'package:material_ui/material_ui.dart';

import '../../data/actions.dart';
import '../../data/questions.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/markdown.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import 'items.dart';

/// 待审批的请求（packages/protocol 的 ApprovalRequest）
extension type Approval(Json json) implements Json {
  String get requestId => json['requestId'] as String;
  String get kind => str(json['kind']) ?? 'tool';
  String get title => str(json['title']) ?? '';
  String? get command => str(json['command']);
  String? get description => str(json['description']);
  String? get plan => str(json['plan']);
  List<Json> get changes => objList(json['changes']);
  List<Question> get questions => [
    for (final q in objList(json['questions'])) Question(q),
  ];
  List<String> get alwaysScopes => [
    for (final s in (json['alwaysScopes'] as List?) ?? const []) s as String,
  ];
  bool get canAllow => json['canAllow'] != false;
  bool get canDeny => json['canDeny'] != false;
  bool get form => json.containsKey('formSchema');
  Json? get wrapper => objOrNull(json['wrapper']);
}

String _alwaysQuestion(String scope) => switch (scope) {
  'session' => L(
    '这个任务里以后同类操作都不再问？',
    'Stop asking about this kind of action in this task?',
  ),
  'project' => L(
    '这个项目里以后同类操作都不再问？',
    'Stop asking about this kind of action in this project?',
  ),
  'user' => L(
    '所有项目里以后同类操作都不再问？',
    'Stop asking about this kind of action in all projects?',
  ),
  _ => L('以后同类操作都不再问？', 'Stop asking about this kind of action?'),
};

class ApprovalCard extends StatefulWidget {
  const ApprovalCard({
    super.key,
    required this.request,
    required this.canAct,
    required this.onAnswer,
    this.more = 0,
    this.onStop,
    this.planNote,
  });
  final Approval request;
  final bool canAct;
  final Future<void> Function(Json decision) onAnswer;

  /// 同时还有几项在等
  final int more;

  /// 正在运行时卡片下面的「停止」
  final VoidCallback? onStop;

  /// 计划卡底下的一句：批准后按哪一档去做（docs/mobile-app.md §15.2）
  final String? planNote;

  @override
  State<ApprovalCard> createState() => _ApprovalCardState();
}

class _ApprovalCardState extends State<ApprovalCard> {
  bool _busy = false;
  bool _confirmAlways = false;
  String? _error;
  final Map<String, QuestionDraft> _drafts = {};

  Future<void> _answer(Json d) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.onAnswer(d);
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = L(
            '没有送到电脑：${actionError(e)}',
            "Didn't reach the computer: ${actionError(e)}",
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = widget.request;
    final off = !widget.canAct || _busy;
    final questions = r.questions;
    final recommended = recommendedAnswers(questions);
    final answers = collectAnswers(questions, _drafts);
    final scope = r.alwaysScopes.isEmpty ? null : r.alwaysScopes.first;
    final icon = switch (r.kind) {
      'command' => Icons.terminal,
      'file_change' => Icons.edit_note,
      'question' => Icons.help_outline,
      'plan' => Icons.checklist,
      _ => Icons.build_outlined,
    };

    Widget buttons() {
      if (r.kind == 'question') {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (recommended != null) ...[
              _Pill(
                label: L('都按推荐', 'Use all recommended'),
                icon: Icons.auto_awesome,
                onTap: off
                    ? null
                    : () => _answer({'type': 'answer', 'answers': recommended}),
              ),
              const SizedBox(height: 8),
            ],
            Row(
              children: [
                Expanded(
                  child: _Pill(
                    label: L('不回答', "Don't answer"),
                    onTap: off ? null : () => _answer({'type': 'deny'}),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  flex: 2,
                  child: _Pill(
                    label: L('提交回答', 'Submit answers'),
                    primary: true,
                    onTap: off || answers == null
                        ? null
                        : () => _answer({'type': 'answer', 'answers': answers}),
                  ),
                ),
              ],
            ),
          ],
        );
      }
      if (r.form) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Note(
              L(
                '这个请求要填一张表单，手机上还填不了，请到电脑上处理；也可以在这里拒绝。',
                "This request needs a form that can't be filled in on the phone yet. Handle it on the computer, or deny it here.",
              ),
            ),
            if (r.canDeny) ...[
              const SizedBox(height: 8),
              _Pill(
                label: L('拒绝', 'Deny'),
                danger: true,
                onTap: off ? null : () => _answer({'type': 'deny'}),
              ),
            ],
          ],
        );
      }
      if (_confirmAlways && scope != null) {
        return Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: c.bgSubtle,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                _alwaysQuestion(scope),
                style: TextStyle(fontSize: Fs.ui, color: c.text),
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: _Pill(
                      label: L('取消', 'Cancel'),
                      onTap: () => setState(() => _confirmAlways = false),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _Pill(
                      label: L('总是允许', 'Always allow'),
                      primary: true,
                      onTap: _busy
                          ? null
                          : () => _answer({
                              'type': 'allow_always',
                              'scope': scope,
                            }),
                    ),
                  ),
                ],
              ),
            ],
          ),
        );
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              if (r.canDeny)
                Expanded(
                  child: _Pill(
                    label: L('拒绝', 'Deny'),
                    onTap: off ? null : () => _answer({'type': 'deny'}),
                  ),
                ),
              if (r.canDeny && r.canAllow) const SizedBox(width: 8),
              if (r.canAllow)
                Expanded(
                  child: _Pill(
                    label: L('允许', 'Allow'),
                    primary: true,
                    onTap: off ? null : () => _answer({'type': 'allow'}),
                  ),
                ),
            ],
          ),
          if (scope != null)
            TextButton(
              style: TextButton.styleFrom(foregroundColor: c.textMuted),
              onPressed: off
                  ? null
                  : () => setState(() => _confirmAlways = true),
              child: Text(L('总是允许…', 'Always allow…')),
            ),
        ],
      );
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(context).height * 0.62,
            ),
            decoration: BoxDecoration(
              color: c.bgSurface,
              borderRadius: BorderRadius.circular(26),
              border: Border.all(color: c.borderCard),
              boxShadow: [
                BoxShadow(
                  color: c.ink.withValues(alpha: 0.08),
                  blurRadius: 20,
                  offset: const Offset(0, 6),
                ),
              ],
            ),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(
                          color: c.warn.withValues(alpha: 0.12),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Icon(icon, size: 20, color: c.warn),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              r.title,
                              style: TextStyle(
                                fontSize: Fs.prose,
                                fontWeight: FontWeight.w600,
                                color: c.text,
                              ),
                            ),
                            Text(
                              [
                                r.kind == 'question'
                                    ? L('需要你回答', 'Needs your answer')
                                    : L(
                                        '需要你允许才能继续',
                                        'Needs your approval to continue',
                                      ),
                                if (widget.more > 0)
                                  L(
                                    '后面还有 ${widget.more} 项',
                                    '${widget.more} more',
                                  ),
                              ].join(' · '),
                              style: TextStyle(
                                fontSize: Fs.meta,
                                color: c.textMuted,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  if (r.description != null && r.description!.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    Text(
                      r.description!,
                      style: TextStyle(
                        fontSize: Fs.list,
                        color: c.textSecondary,
                      ),
                    ),
                  ],
                  if (r.wrapper != null &&
                      ((r.wrapper!['extra'] as List?)?.isNotEmpty ??
                          false)) ...[
                    const SizedBox(height: 10),
                    _Note(
                      L(
                        '外层 ${r.wrapper!['shell']} 还带了参数：${(r.wrapper!['extra'] as List).join(' ')}',
                        'The outer ${r.wrapper!['shell']} also has arguments: ${(r.wrapper!['extra'] as List).join(' ')}',
                      ),
                      warn: true,
                    ),
                  ],
                  if (r.command != null) ...[
                    const SizedBox(height: 10),
                    Container(
                      constraints: const BoxConstraints(maxHeight: 160),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: c.bgSubtle,
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: SingleChildScrollView(
                        child: SelectableText(
                          r.command!,
                          style: TextStyle(
                            fontSize: Fs.meta,
                            height: 1.45,
                            fontFamily: 'monospace',
                            color: c.text,
                          ),
                        ),
                      ),
                    ),
                  ],
                  for (final ch in r.changes) ...[
                    const SizedBox(height: 10),
                    Text(
                      str(ch['path']) ?? '',
                      style: TextStyle(
                        fontSize: Fs.meta,
                        fontFamily: 'monospace',
                        color: c.textMuted,
                      ),
                    ),
                    const SizedBox(height: 4),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 200),
                      child: SingleChildScrollView(
                        child: DiffView(str(ch['diff']) ?? ''),
                      ),
                    ),
                  ],
                  if (r.plan != null) ...[
                    const SizedBox(height: 10),
                    Container(
                      constraints: const BoxConstraints(maxHeight: 260),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 14,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: c.bgSubtle,
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: SingleChildScrollView(
                        child: ReplyMarkdown(r.plan!),
                      ),
                    ),
                    if (widget.planNote != null) ...[
                      const SizedBox(height: 6),
                      Text(
                        widget.planNote!,
                        style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                      ),
                    ],
                  ],
                  if (r.kind == 'question')
                    for (final q in questions)
                      _QuestionField(
                        question: q,
                        draft: _drafts[q.question] ?? emptyDraft,
                        disabled: off,
                        onChange: (d) =>
                            setState(() => _drafts[q.question] = d),
                      ),
                  const SizedBox(height: 14),
                  buttons(),
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        _error!,
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: Fs.meta, color: c.danger),
                      ),
                    ),
                  if (!widget.canAct)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        L(
                          '没连上电脑，或这部手机是「只看」，要在电脑上处理。',
                          'Not connected, or this phone is “View only”. Handle this on the computer.',
                        ),
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (widget.onStop != null && widget.canAct)
            Center(
              child: TextButton.icon(
                style: TextButton.styleFrom(foregroundColor: c.textMuted),
                onPressed: widget.onStop,
                icon: const Icon(Icons.stop_rounded, size: 18),
                label: Text(L('停止', 'Stop')),
              ),
            ),
        ],
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text, {this.warn = false});
  final String text;
  final bool warn;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: warn ? c.warn.withValues(alpha: 0.12) : c.bgSubtle,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: Fs.meta,
          color: warn ? c.warn : c.textSecondary,
        ),
      ),
    );
  }
}

/// 大圆角按钮：主按钮深底，次按钮浅灰，危险红字
class _Pill extends StatelessWidget {
  const _Pill({
    required this.label,
    required this.onTap,
    this.primary = false,
    this.danger = false,
    this.icon,
  });
  final String label;
  final VoidCallback? onTap;
  final bool primary;
  final bool danger;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final on = onTap != null;
    final bg = primary ? (on ? c.btnPrimaryBg : c.bgSelected) : c.bgSubtle;
    final fg = primary
        ? (on ? c.btnPrimaryText : c.textFaint)
        : danger
        ? c.danger
        : (on ? c.text : c.textFaint);
    return Material(
      color: bg,
      shape: const StadiumBorder(),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: SizedBox(
          height: 48,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 18, color: fg),
                const SizedBox(width: 6),
              ],
              Text(
                label,
                style: TextStyle(
                  fontSize: Fs.prose,
                  fontWeight: FontWeight.w600,
                  color: fg,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 一道题：选项（推荐的带标签）、「其他」自己填；没有选项的题直接填
class _QuestionField extends StatelessWidget {
  const _QuestionField({
    required this.question,
    required this.draft,
    required this.disabled,
    required this.onChange,
  });
  final Question question;
  final QuestionDraft draft;
  final bool disabled;
  final ValueChanged<QuestionDraft> onChange;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final q = question;
    final writing = q.options.isEmpty || draft.other;

    Widget choice(
      bool on,
      VoidCallback tap,
      String title, {
      String? description,
      bool badge = false,
    }) => Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: on ? c.accentSoft : c.bgSurface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: on ? c.accent : c.borderCard),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: disabled ? null : tap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  q.multiSelect
                      ? (on ? Icons.check_box : Icons.check_box_outline_blank)
                      : (on
                            ? Icons.radio_button_checked
                            : Icons.radio_button_unchecked),
                  size: 20,
                  color: on ? c.accent : c.textFaint,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 6,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(
                            title,
                            style: TextStyle(fontSize: Fs.ui, color: c.text),
                          ),
                          if (badge)
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 1,
                              ),
                              decoration: BoxDecoration(
                                color: c.accentSoft,
                                borderRadius: BorderRadius.circular(99),
                              ),
                              child: Text(
                                L('推荐', 'Recommended'),
                                style: TextStyle(
                                  fontSize: Fs.label,
                                  color: c.accentText,
                                ),
                              ),
                            ),
                        ],
                      ),
                      if (description != null && description.isNotEmpty)
                        Text(
                          description,
                          style: TextStyle(
                            fontSize: Fs.meta,
                            color: c.textMuted,
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );

    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            q.question,
            style: TextStyle(
              fontSize: Fs.ui,
              fontWeight: FontWeight.w600,
              color: c.text,
            ),
          ),
          if (q.multiSelect)
            Text(
              L('可以多选', 'Select all that apply'),
              style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
            ),
          const SizedBox(height: 8),
          for (final o in q.options)
            choice(
              draft.picks.contains(o.label),
              () => onChange(pickOption(q, draft, o.label)),
              displayLabel(o.label),
              description: o.description,
              badge: isRecommended(o.label),
            ),
          if (canWriteIn(q) && q.options.isNotEmpty)
            choice(
              draft.other,
              () => onChange(toggleOther(q, draft)),
              L('其他（自己填）', 'Other (write your own)'),
            ),
          if (writing)
            TextFormField(
              initialValue: draft.text,
              enabled: !disabled,
              obscureText: q.secret,
              minLines: q.secret ? 1 : 2,
              maxLines: q.secret ? 1 : 5,
              autocorrect: !q.secret,
              enableSuggestions: !q.secret,
              onChanged: (v) => onChange(draft.copyWith(text: v)),
              decoration: InputDecoration(
                hintText: q.secret
                    ? L('输入内容（不会显示出来）', 'Enter text (hidden)')
                    : L('写下你的回答', 'Write your answer'),
              ),
            ),
        ],
      ),
    );
  }
}

/// 打开时确认一次（放宽权限、打开快速模式、归档）；点了「确定」返回 true
Future<bool> confirm(BuildContext context, String text, {String? ok}) async {
  final c = context.colors;
  final r = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      content: Text(
        text,
        style: TextStyle(fontSize: Fs.ui, color: c.text, height: 1.5),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: Text(L('取消', 'Cancel')),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context, true),
          child: Text(ok ?? L('确定', 'OK')),
        ),
      ],
    ),
  );
  return r == true;
}
