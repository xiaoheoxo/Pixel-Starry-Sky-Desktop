// 提问卡片的作答：推荐项、「都按推荐」、自己填答案。规则照网页版 apps/mobile/src/data/questions.ts
// （同桌面 questionModel.ts），测试照 questions.test.ts。
import '../protocol/json.dart';

/// 提问（packages/protocol 的 Question）
extension type Question(Json json) implements Json {
  String get question => str(json['question']) ?? '';
  bool get multiSelect => json['multiSelect'] == true;
  bool get allowOther => json['allowOther'] == true;
  bool get secret => json['secret'] == true;
  List<({String label, String description})> get options => [
    for (final o in objList(json['options']))
      (label: str(o['label']) ?? '', description: str(o['description']) ?? ''),
  ];
}

final _mark = RegExp(
  r'\s*[（(]\s*(?:推荐|recommended)\s*[)）]\s*',
  caseSensitive: false,
);

bool isRecommended(String label) => _mark.hasMatch(label);

/// 显示用：去掉推荐记号；提交时仍用原文
String displayLabel(String label) {
  final s = label.replaceAll(_mark, ' ').trim();
  return s.isEmpty ? label : s;
}

/// 每题都有推荐项时按推荐作答；否则 null
Map<String, String>? recommendedAnswers(List<Question> questions) {
  if (questions.isEmpty) return null;
  final answers = <String, String>{};
  for (final q in questions) {
    final picks = [
      for (final o in q.options)
        if (isRecommended(o.label)) o.label,
    ];
    if (picks.isEmpty) return null;
    answers[q.question] = (q.multiSelect ? picks : picks.take(1)).join(', ');
  }
  return answers;
}

/// 一题的作答状态：picks 是选中的选项原文，other 为 true 时 text 是自己输入的
class QuestionDraft {
  const QuestionDraft({
    this.picks = const [],
    this.other = false,
    this.text = '',
  });
  final List<String> picks;
  final bool other;
  final String text;

  QuestionDraft copyWith({List<String>? picks, bool? other, String? text}) =>
      QuestionDraft(
        picks: picks ?? this.picks,
        other: other ?? this.other,
        text: text ?? this.text,
      );
}

const emptyDraft = QuestionDraft();

/// 能不能自己输入：引擎允许，或这题没有选项
bool canWriteIn(Question q) => q.allowOther || q.options.isEmpty;

/// 点一个选项：单选换成它并取消「其他」，多选切换它
QuestionDraft pickOption(Question q, QuestionDraft d, String label) {
  if (!q.multiSelect) return d.copyWith(picks: [label], other: false);
  return d.copyWith(
    picks: d.picks.contains(label)
        ? [
            for (final x in d.picks)
              if (x != label) x,
          ]
        : [...d.picks, label],
  );
}

/// 点「其他」：单选清掉选项，多选并存；再点一次收起（输入保留，提交时不算）
QuestionDraft toggleOther(Question q, QuestionDraft d) =>
    q.multiSelect || d.other
    ? d.copyWith(other: !d.other)
    : d.copyWith(picks: const [], other: true);

/// 这题的答案；没答完是 null。多选用「, 」连起来
String? draftAnswer(Question q, QuestionDraft d) {
  final text = d.text.trim();
  final writing = q.options.isEmpty || d.other;
  if (writing && text.isEmpty) return null;
  final parts = [...d.picks, if (writing) text];
  return parts.isEmpty ? null : parts.join(', ');
}

/// 全部答完时返回 问题 → 答案；有一题没答完是 null
Map<String, String>? collectAnswers(
  List<Question> questions,
  Map<String, QuestionDraft> drafts,
) {
  final answers = <String, String>{};
  for (final q in questions) {
    final value = draftAnswer(q, drafts[q.question] ?? emptyDraft);
    if (value == null) return null;
    answers[q.question] = value;
  }
  return answers;
}
