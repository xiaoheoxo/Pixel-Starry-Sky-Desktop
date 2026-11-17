// 手机用到的协议常量和小工具：照搬 packages/protocol/src 的 util.ts、engines.ts、session-metadata.ts。
// 和 TS 对照的样例：test/fixtures/protocol_constants.json、protocol_text.json（diffStat）。
import 'json.dart';

/// 不属于任何项目的对话（「对话」模式）的项目 id
const chatProjectId = 'chat';

/// 权限模式，按菜单里的顺序
const permissionModes = ['ask', 'edits', 'auto', 'plan', 'full'];

/// 推理强度，从低到高
const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/// 引擎的说明（只留手机用到的能力）
class EngineDescriptor {
  const EngineDescriptor({
    required this.id,
    required this.name,
    required this.short,
    required this.permissionModes,
    required this.efforts,
    required this.imageInput,
    required this.interrupt,
    required this.steer,
    required this.ultracode,
    required this.fast,
    required this.thinkingSummaries,
    required this.liveModelSwitch,
    required this.livePermissionSwitch,
    required this.rewind,
    required this.sideChat,
  });
  final String id;
  final String name;
  final String short;
  final List<String> permissionModes;
  final List<String> efforts;
  final bool imageInput;
  final bool interrupt;
  final bool steer;
  final bool ultracode;
  final bool fast;

  /// 有「显示思考摘要」开关
  final bool thinkingSummaries;

  /// 运行中换模型、强度当轮生效（否则下一轮）
  final bool liveModelSwitch;

  /// 运行中改权限当轮生效（否则下一轮）
  final bool livePermissionSwitch;

  /// 能回退到自己的某条消息（手机上「编辑重发」）
  final bool rewind;

  /// 能旁聊（不打断正在跑的这一轮问一句，docs/mobile-app.md §15.3）
  final bool sideChat;
}

const engines = <String, EngineDescriptor>{
  'claude': EngineDescriptor(
    id: 'claude',
    name: 'Claude Code',
    short: 'Cc',
    permissionModes: ['ask', 'edits', 'plan', 'full'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    imageInput: true,
    interrupt: true,
    steer: false,
    ultracode: true,
    fast: true,
    thinkingSummaries: true,
    liveModelSwitch: true,
    livePermissionSwitch: true,
    rewind: true,
    sideChat: true,
  ),
  'codex': EngineDescriptor(
    id: 'codex',
    name: 'Codex',
    short: 'Cx',
    permissionModes: ['ask', 'edits', 'auto', 'plan', 'full'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    imageInput: true,
    interrupt: true,
    steer: true,
    ultracode: false,
    fast: true,
    thinkingSummaries: true,
    liveModelSwitch: false,
    livePermissionSwitch: false,
    rewind: true,
    sideChat: true,
  ),
  'pixel': EngineDescriptor(
    id: 'pixel',
    name: 'Pixel',
    short: 'Px',
    permissionModes: ['ask', 'edits', 'plan', 'full'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    imageInput: true,
    interrupt: true,
    steer: true,
    ultracode: false,
    fast: true,
    thinkingSummaries: false,
    liveModelSwitch: true,
    livePermissionSwitch: true,
    rewind: false,
    sideChat: true,
  ),
  'antigravity': EngineDescriptor(
    id: 'antigravity',
    name: 'Antigravity',
    short: 'Ag',
    permissionModes: ['ask', 'edits', 'plan', 'full'],
    efforts: ['low', 'medium', 'high'],
    imageInput: true,
    interrupt: true,
    steer: false,
    ultracode: false,
    fast: false,
    thinkingSummaries: false,
    liveModelSwitch: true,
    livePermissionSwitch: true,
    rewind: false,
    sideChat: false,
  ),
};

/// 汇总几处改动的增删行数
({int added, int removed}) diffStat(List<Json> changes) {
  var added = 0;
  var removed = 0;
  for (final c in changes) {
    added += (c['added'] as num).toInt();
    removed += (c['removed'] as num).toInt();
  }
  return (added: added, removed: removed);
}
