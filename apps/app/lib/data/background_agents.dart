// 一轮说完后还在后台跑的子智能体 / 编排（docs/mobile-app.md §17）：照 packages/protocol/src/backgroundAgents.ts。
import '../protocol/json.dart';

typedef BackgroundAgent = ({
  String id,
  String label,
  bool workflow,
  String? message,
});

/// 子智能体条里 background 且 running 的，加上后台任务里 local_agent* / local_workflow* 的；按 id 去重，名字优先用子智能体条的
List<BackgroundAgent> backgroundAgents(Json? snapshot) {
  final out = <String, BackgroundAgent>{};
  String short(String id) => id.length > 8 ? id.substring(0, 8) : id;
  for (final a in objList(snapshot?['subagents'])) {
    final id = str(a['id']) ?? '';
    if (id.isEmpty || a['status'] != 'running' || a['background'] != true) {
      continue;
    }
    final label = str(a['label']) ?? '';
    out[id] = (
      id: id,
      label: label.isEmpty ? short(id) : label,
      workflow: false,
      message: str(a['message']),
    );
  }
  for (final t in objList(snapshot?['tasks'])) {
    final id = str(t['id']) ?? '';
    final kind = str(t['kind']) ?? '';
    final agent = kind.startsWith('local_agent');
    final workflow = kind.startsWith('local_workflow');
    if (id.isEmpty || (!agent && !workflow) || out.containsKey(id)) continue;
    final label = str(t['description']) ?? '';
    out[id] = (
      id: id,
      label: label.isEmpty ? short(id) : label,
      workflow: workflow,
      message: str(t['message']),
    );
  }
  return out.values.toList();
}
