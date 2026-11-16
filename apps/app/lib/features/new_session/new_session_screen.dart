// 新对话页（规则照网页版 NewTask.tsx）：居中的问候下面两颗胶囊——项目、引擎；底部和会话页一样的输入框，
// 「＋」加图片，输入框上面一颗模式胶囊（权限、模型、强度、速度，没选的用电脑上的设置）。
// 引擎默认用电脑上设的那个；换了引擎模型和强度回到电脑上的设置，权限新引擎也支持就留着。
// 建好会话但消息没发成功：再点不再新建，消息沿用同一个 ID（data/retry.dart）。
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../connection/desktop_link.dart';
import '../../data/actions.dart';
import '../../data/images.dart';
import '../../data/mode.dart';
import '../../i18n/i18n.dart';
import '../../protocol/constants.dart';
import '../../protocol/json.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../session/approval_card.dart' show confirm;
import '../session/composer.dart';
import '../session/mode_sheet.dart';
import '../session/session_screen.dart';

void openNewSession(
  BuildContext context,
  String deviceId, {
  String? projectId,
  String? draft,
}) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => NewSessionScreen(
        deviceId: deviceId,
        projectId: projectId,
        draft: draft,
      ),
    ),
  );
}

/// 新会话的模式；null 都是「用电脑上的设置」
class _Mode {
  const _Mode({this.permissionMode, this.model, this.effort, this.fast});
  final String? permissionMode;
  final String? model;
  final String? effort;
  final bool? fast;

  Json toJson() => {
    'permissionMode': ?permissionMode,
    'model': ?model,
    'effort': ?effort,
    'fast': ?fast,
  };
}

class NewSessionScreen extends StatefulWidget {
  const NewSessionScreen({
    super.key,
    required this.deviceId,
    this.projectId,
    this.draft,
  });
  final String deviceId;
  final String? projectId;

  /// 输入框里先放好的字（任务「交给 AI」）
  final String? draft;
  @override
  State<NewSessionScreen> createState() => _NewSessionScreenState();
}

class _NewSessionScreenState extends State<NewSessionScreen> {
  late final DesktopActions _desktop;
  String? _projectId;
  String? _picked;
  String? _defaultEngine;
  _Mode _mode = const _Mode();
  String _modeEngine = '';
  late final _draft = TextEditingController(text: widget.draft);
  final _images = PendingImages();
  bool _started = false;

  // 上次建好了会话、但消息没发成功：重试时不再新建
  ({String key, String id})? _created;
  SessionActions? _sending;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    _desktop = DesktopActions(
      AppScope.read(context).connections,
      widget.deviceId,
    );
    _projectId = widget.projectId;
    _desktop.defaultEngine().then((e) {
      if (mounted) setState(() => _defaultEngine = e);
    });
  }

  @override
  void dispose() {
    _draft.dispose();
    _images.dispose();
    super.dispose();
  }

  String get _engine =>
      _picked ??
      (engines.containsKey(_defaultEngine) ? _defaultEngine! : 'claude');

  /// 换了引擎：模型和强度回到电脑上的设置，权限新引擎也支持就留着
  _Mode get _modeNow {
    if (_modeEngine == _engine) return _mode;
    final kept = _mode.permissionMode;
    return _Mode(
      permissionMode:
          kept != null &&
              (engines[_engine]?.permissionModes.contains(kept) ?? false)
          ? kept
          : null,
    );
  }

  void _setMode(_Mode m) => setState(() {
    _mode = m;
    _modeEngine = _engine;
  });

  String _modeText(_Mode m) {
    final chip = modeChip({
      'permissionMode': m.permissionMode ?? 'ask',
      'model': m.model,
      'effort': m.effort,
    });
    final parts = [
      if (m.permissionMode != null) chip.permission,
      ?chip.model,
      ?chip.effort,
      if (m.fast != null) m.fast! ? L('快速', 'Fast') : L('普通速度', 'Normal speed'),
    ];
    return parts.isEmpty
        ? L('用电脑上的设置', "Computer's settings")
        : parts.join(' · ');
  }

  Future<void> _create(
    String text,
    List<Attachment> images,
    String projectId,
  ) async {
    final mode = _modeNow;
    final settings = {
      'projectId': projectId,
      'engine': _engine,
      ...mode.toJson(),
    };
    final key = settings.toString();
    final connections = AppScope.read(context).connections;
    if (_created?.key != key) {
      try {
        final id = await _desktop.createSession(settings);
        _created = (key: key, id: id);
        _sending = SessionActions(connections, widget.deviceId, id);
      } catch (e) {
        if ('$e' == 'MOBILE_BAD_ARGUMENT') {
          throw Exception(
            L(
              '电脑不接受这个模式，换一个或用电脑上的设置。',
              "The computer didn't accept this mode. Pick another or use the computer's settings.",
            ),
          );
        }
        rethrow;
      }
    }
    final id = _created!.id;
    await _sending!.send(text, images);
    _created = null;
    if (mounted) openSession(context, widget.deviceId, id, replace: true);
  }

  Future<void> _pickProject(
    List<({String id, String name, String path})> projects,
    String? chosen,
  ) async {
    final c = context.colors;
    final id = await showPanel<String>(
      context,
      (context) => ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.7,
        ),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 12),
              child: Text(
                L('项目', 'Project'),
                style: TextStyle(
                  fontSize: Fs.section,
                  fontWeight: FontWeight.w600,
                  color: c.text,
                ),
              ),
            ),
            Section(
              children: [
                for (final p in projects)
                  ListRow(
                    leading: Icon(Icons.folder_outlined, color: c.textMuted),
                    title: p.name,
                    subtitle: p.path,
                    trailing: p.id == chosen
                        ? Icon(Icons.check, color: c.accentText)
                        : const SizedBox(),
                    onTap: () => Navigator.pop(context, p.id),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
    if (id != null) setState(() => _projectId = id);
  }

  Future<void> _pickEngine() async {
    final c = context.colors;
    final id = await showPanel<String>(
      context,
      (context) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 0, 4, 12),
                child: Text(
                  L('引擎', 'Engine'),
                  style: TextStyle(
                    fontSize: Fs.section,
                    fontWeight: FontWeight.w600,
                    color: c.text,
                  ),
                ),
              ),
              Section(
                children: [
                  for (final e in engines.values)
                    ListRow(
                      title: e.name,
                      trailing: e.id == _engine
                          ? Icon(Icons.check, color: c.accentText)
                          : const SizedBox(),
                      onTap: () => Navigator.pop(context, e.id),
                    ),
                ],
              ),
              if (_defaultEngine != null && _picked == null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    L(
                      '默认用电脑上设的引擎。',
                      'Defaults to the engine set on the computer.',
                    ),
                    style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
    if (id != null) setState(() => _picked = id);
  }

  Future<void> _openMode() async {
    await showPanel<void>(
      context,
      (_) => StatefulBuilder(
        builder: (context, setSheet) => FutureBuilder<List<EngineModel>>(
          future: _desktop.catalog(_engine),
          builder: (context, snap) {
            final m = _modeNow;
            final unsupported =
                snap.hasError && '${snap.error}' == 'MOBILE_UNSUPPORTED';
            final models = snap.hasData
                ? snap.data
                : (snap.hasError ? const <EngineModel>[] : null);
            EngineModel? current;
            for (final x in models ?? const <EngineModel>[]) {
              if (x.id == m.model) current = x;
            }
            void set(_Mode next) {
              _setMode(next);
              setSheet(() {});
            }

            return ModePanel(
              title: L('新会话的模式', 'Mode for the new conversation'),
              readOnly: unsupported,
              error: unsupported
                  ? L(
                      '电脑上的像素星空版本较旧，新会话用电脑上的设置。',
                      "The computer's PixelSky is out of date. The new conversation uses the computer's settings.",
                    )
                  : null,
              note: L(
                '没选的项用电脑上的设置。',
                "Anything not selected uses the computer's settings.",
              ),
              groups: [
                ModeGroup(
                  title: L('权限', 'Permissions'),
                  options: permissionOptions(_engine, null),
                  value: m.permissionMode ?? '',
                  onPick: (v) async {
                    if (v.isNotEmpty &&
                        widens(null, v) &&
                        !await confirm(context, widenConfirm())) {
                      return;
                    }
                    set(
                      _Mode(
                        permissionMode: v.isEmpty ? null : v,
                        model: m.model,
                        effort: m.effort,
                        fast: m.fast,
                      ),
                    );
                  },
                ),
                ModeGroup(
                  title: models == null
                      ? L('模型（正在取）', 'Model (loading)')
                      : L('模型', 'Model'),
                  options: modelOptions(models, m.model),
                  value: m.model ?? '',
                  // 换了模型：强度可能不在新模型的范围里，回到默认
                  onPick: (v) => set(
                    _Mode(
                      permissionMode: m.permissionMode,
                      model: v.isEmpty ? null : v,
                      fast: m.fast,
                    ),
                  ),
                ),
                ModeGroup(
                  title: L('推理强度', 'Reasoning effort'),
                  options: effortOptions(_engine, current, m.effort),
                  value: m.effort ?? '',
                  segmented: true,
                  onPick: (v) => set(
                    _Mode(
                      permissionMode: m.permissionMode,
                      model: m.model,
                      effort: v.isEmpty ? null : v,
                      fast: m.fast,
                    ),
                  ),
                ),
                if (engines[_engine]?.fast == true)
                  ModeGroup(
                    title: L('速度', 'Speed'),
                    options: [
                      ModeOption('', L('电脑上的设置', "Computer's settings")),
                      ModeOption('off', L('普通', 'Normal')),
                      ModeOption(
                        'on',
                        L('快速模式', 'Fast mode'),
                        hint: fastDefaultHint(),
                      ),
                    ],
                    value: m.fast == null ? '' : (m.fast! ? 'on' : 'off'),
                    onPick: (v) async {
                      if (v == 'on' && !await confirm(context, fastConfirm())) {
                        return;
                      }
                      set(
                        _Mode(
                          permissionMode: m.permissionMode,
                          model: m.model,
                          effort: m.effort,
                          fast: v.isEmpty ? null : v == 'on',
                        ),
                      );
                    },
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final services = AppScope.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([services.lists, services.connections]),
      builder: (context, _) {
        final data = services.lists.get(widget.deviceId);
        final projects = [
          for (final p in data.projects) (id: p.id, name: p.name, path: p.path),
        ];
        final chosen = projects.any((p) => p.id == _projectId)
            ? _projectId
            : (projects.isEmpty ? null : projects.first.id);
        String? projectName;
        for (final p in projects) {
          if (p.id == chosen) projectName = p.name;
        }
        final ready =
            services.connections.state(widget.deviceId) == LinkState.ready &&
            chosen != null;
        final pairing = services.connections.pairings.where(
          (p) => p.deviceId == widget.deviceId,
        );
        Widget pill(IconData? icon, String text, VoidCallback onTap) =>
            Material(
              color: c.bgSurface,
              shape: StadiumBorder(side: BorderSide(color: c.borderCard)),
              clipBehavior: Clip.antiAlias,
              child: InkWell(
                onTap: onTap,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 9,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (icon != null) ...[
                        Icon(icon, size: 16, color: c.textMuted),
                        const SizedBox(width: 6),
                      ],
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 200),
                        child: Text(
                          text,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: Fs.list, color: c.text),
                        ),
                      ),
                      const SizedBox(width: 2),
                      Icon(Icons.expand_more, size: 16, color: c.textFaint),
                    ],
                  ),
                ),
              ),
            );
        return AppScreen(
          title: L('新对话', 'New conversation'),
          subtitle: pairing.isEmpty
              ? null
              : L(
                  '在 ${pairing.first.desktopName} 上',
                  'On ${pairing.first.desktopName}',
                ),
          leading: RoundIconButton(
            icon: Icons.arrow_back,
            tooltip: L('返回', 'Back'),
            onPressed: () => Navigator.of(context).pop(),
          ),
          body: data.loaded && projects.isEmpty
              ? EmptyState(
                  icon: Icons.folder_outlined,
                  title: L('电脑上还没有项目', 'No projects on the computer yet'),
                  body: L(
                    '先在电脑上的像素星空里添加一个项目文件夹。',
                    'Add a project folder in PixelSky on the computer first.',
                  ),
                )
              : Center(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          L('想让 AI 做点什么？', 'What should the AI do?'),
                          style: TextStyle(
                            fontSize: Fs.section,
                            fontWeight: FontWeight.w600,
                            color: c.text,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          L(
                            '会在电脑上的项目里运行',
                            'Runs in a project on your computer',
                          ),
                          style: TextStyle(
                            fontSize: Fs.meta,
                            color: c.textFaint,
                          ),
                        ),
                        const SizedBox(height: 18),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          alignment: WrapAlignment.center,
                          children: [
                            pill(
                              Icons.folder_outlined,
                              projectName ?? L('选项目', 'Project'),
                              () => _pickProject(projects, chosen),
                            ),
                            pill(
                              null,
                              engines[_engine]?.name ?? _engine,
                              _pickEngine,
                            ),
                            pill(Icons.tune, _modeText(_modeNow), _openMode),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
          bottom: Composer(
            draft: _draft,
            canAct: ready,
            running: false,
            autofocus: true,
            engineName: engines[_engine]?.name ?? _engine,
            images: _images,
            placeholder: L(
              '例如：把登录页的按钮改成圆角，并补上单元测试',
              'e.g. Round the login buttons and add unit tests',
            ),
            onSend: (text, images) => _create(text, images, chosen!),
          ),
        );
      },
    );
  }
}
