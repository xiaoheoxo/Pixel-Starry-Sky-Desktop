// 新反馈（docs/mobile-app.md §8.5，照电脑 docs/ui/feedback.md §2.3）：类型、标题、描述、复现步骤（仅问题）、截图，
// 附带信息：手机信息（总带，拼在正文末尾）、电脑诊断信息（默认带）、电脑最近 2 小时日志（问题默认勾，可预览原文）。
// 日志只发时间窗，电脑自己取；草稿按电脑存本机（图片不存）。提交成功后换成这条反馈的详情。
import '../../app/log.dart';

import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../data/feedback.dart';
import '../../data/images.dart';
import '../../data/tasks.dart' show Tone;
import '../../data/tools.dart';
import '../../i18n/i18n.dart';
import '../../platform/phone_info.dart';
import '../../protocol/json.dart';
import '../../ui/image_attach.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../tools/common.dart';
import 'feedback_thread.dart';

class FeedbackFormScreen extends StatefulWidget {
  const FeedbackFormScreen({super.key, required this.deviceId});
  final String deviceId;
  @override
  State<FeedbackFormScreen> createState() => _FeedbackFormScreenState();
}

class _FeedbackFormScreenState extends State<FeedbackFormScreen> {
  late final _services = AppScope.read(context);
  late final Map<String, Object?>? _draft = _services.settings.feedbackDraft(
    widget.deviceId,
  );
  late String _type = (_draft?['type'] as String?) ?? 'bug';
  late final _title = TextEditingController(text: _draft?['title'] as String?);
  late final _body = TextEditingController(text: _draft?['body'] as String?);
  late final _steps = TextEditingController(text: _draft?['steps'] as String?);
  late bool _showSteps = ((_draft?['steps'] as String?) ?? '').isNotEmpty;
  final _images = PendingImages();
  bool _diagnostics = true;
  late bool _logs = _type == 'bug';

  /// 附上手机日志（§19，同电脑日志：问题默认勾）
  late bool _phoneLog = _type == 'bug';

  /// 手机信息一行（异步取机型）
  String _phone = '';

  /// 电脑诊断信息、日志的预览（点「查看」才取）
  Json? _preview;
  bool _previewing = false;
  bool _showDiagnostics = false;
  bool _showLogs = false;

  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    phoneInfo().then((p) {
      if (mounted) setState(() => _phone = p);
    });
    for (final c in [_title, _body, _steps]) {
      c.addListener(_saveDraft);
    }
    _images.addListener(_changed);
  }

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    _steps.dispose();
    _images.dispose();
    super.dispose();
  }

  void _changed() => setState(() {});

  void _saveDraft() {
    _services.settings.setFeedbackDraft(widget.deviceId, {
      'type': _type,
      'title': _title.text,
      'body': _body.text,
      'steps': _steps.text,
    });
    setState(() {});
  }

  /// 预览：电脑诊断信息 + 最近日志（从现在往前 2 小时）
  Future<void> _loadPreview() async {
    if (_previewing) return;
    setState(() => _previewing = true);
    try {
      final now = DateTime.now().millisecondsSinceEpoch;
      final r = obj(
        await callTool(
          _services.connections,
          widget.deviceId,
          'feedback:preview',
          [
            {'since': now - feedbackLogWindow.inMilliseconds, 'until': now},
          ],
        ),
      );
      if (mounted) setState(() => _preview = r);
    } catch (e) {
      if (mounted) setState(() => _error = feedbackError(e));
    } finally {
      if (mounted) setState(() => _previewing = false);
    }
  }

  String get _fullBody {
    final steps = _type == 'bug' ? _steps.text : '';
    final base = composeFeedbackBody(
      body: _body.text,
      steps: steps,
      phone: _phone,
    );
    final log = _phoneLogText;
    if (!_phoneLog || log.isEmpty) return base;
    // 手机日志占剩下的额度（标题、代码块的框留 60 字）；剩得太少就不带
    final room = FeedbackLimits.bodyChars - base.length - 60;
    if (room < 200) return base;
    return composeFeedbackBody(
      body: _body.text,
      steps: steps,
      phone: _phone,
      phoneLog: tailLines(log, room),
    );
  }

  /// 最近 2 小时的手机日志（§19）
  String get _phoneLogText =>
      logText(recentLogs(appLog.entries, feedbackLogWindow));

  Future<void> _submit() async {
    final limit = feedbackLimitError(
      title: _title.text,
      body: _fullBody,
      images: _images.images.length,
    );
    if (limit != null) {
      setState(() => _error = limit);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final now = DateTime.now().millisecondsSinceEpoch;
      final detail = obj(
        await callTool(
          _services.connections,
          widget.deviceId,
          'feedback:create',
          [
            {
              'type': _type,
              'title': _title.text.trim(),
              'body': _fullBody,
              'diagnostics': _diagnostics,
              'logs': _logs
                  ? {
                      'since': now - feedbackLogWindow.inMilliseconds,
                      'until': now,
                    }
                  : null,
              'images': feedbackImages(_images.images),
            },
          ],
        ),
      );
      await _services.settings.setFeedbackDraft(widget.deviceId, null);
      if (!mounted) return;
      final thread = obj(detail['thread']);
      Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => FeedbackThreadScreen(
            deviceId: widget.deviceId,
            threadId: str(thread['id']) ?? '',
            title: str(thread['title']) ?? _title.text.trim(),
            initial: detail,
          ),
        ),
      );
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = feedbackError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final canAct = canActOn(_services.connections, widget.deviceId);
    final logs = objOrNull(_preview?['logs']);
    InputDecoration field(String hint) => InputDecoration(
      hintText: hint,
      hintStyle: TextStyle(color: c.textFaint),
      isDense: true,
      filled: true,
      fillColor: c.bgSubtle,
      counterText: '',
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(Radii.card),
        borderSide: BorderSide.none,
      ),
    );
    final label = TextStyle(fontSize: Fs.meta, color: c.textMuted);
    return ToolFrame(
      title: L('新反馈', 'New feedback'),
      footer: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                L(
                  '以电脑上登录的账号提交 · 只有像素星空团队能看到',
                  'Sent with the account signed in on your computer · only the PixelSky team can see it',
                ),
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: Fs.label, color: c.textFaint),
              ),
            ),
            PrimaryButton(
              icon: Icons.send_outlined,
              busy: _busy,
              label: _busy ? L('正在提交…', 'Submitting…') : L('提交', 'Submit'),
              onPressed:
                  !canAct ||
                      _busy ||
                      _images.busy ||
                      _title.text.trim().isEmpty ||
                      _body.text.trim().isEmpty
                  ? null
                  : _submit,
            ),
          ],
        ),
      ),
      children: [
        if (_draft != null)
          ToolBanner(L('已恢复上次没提交的草稿', 'Restored your unsent draft')),
        if (!canAct)
          ToolBanner(
            L(
              '这部手机是「只看」，在电脑 设置 › 手机 里改成「可操作」才能提交。',
              'This phone is “View only”. Change it to “Can act” in Settings › Phone on your computer to send.',
            ),
            tone: Tone.warn,
          ),
        if (_error != null) ToolBanner(_error!, tone: Tone.danger),
        SegmentedButton<String>(
          showSelectedIcon: false,
          style: SegmentedButton.styleFrom(
            backgroundColor: Colors.transparent,
            foregroundColor: c.textMuted,
            selectedBackgroundColor: c.bgSelected,
            selectedForegroundColor: c.text,
            side: BorderSide(color: c.borderSubtle),
            textStyle: const TextStyle(fontSize: Fs.ui),
          ),
          segments: [
            for (final t in ['bug', 'feature', 'other'])
              ButtonSegment(value: t, label: Text(feedbackTypeText(t))),
          ],
          selected: {_type},
          onSelectionChanged: (v) {
            _type = v.first;
            // 换类型时日志默认跟着变（同电脑：只有问题默认带）
            _logs = _type == 'bug';
            _phoneLog = _type == 'bug';
            _saveDraft();
          },
        ),
        const SizedBox(height: 16),
        Text(L('标题', 'Title'), style: label),
        const SizedBox(height: 6),
        TextField(
          controller: _title,
          maxLength: FeedbackLimits.titleChars,
          style: TextStyle(fontSize: Fs.prose, color: c.text),
          decoration: field(L('一句话说清楚', 'Summarise it in one line')),
        ),
        const SizedBox(height: 14),
        Text(L('描述', 'Description'), style: label),
        const SizedBox(height: 6),
        TextField(
          controller: _body,
          minLines: 4,
          maxLines: 10,
          style: TextStyle(fontSize: Fs.prose, color: c.text),
          decoration: field(feedbackBodyHint(_type)),
        ),
        if (_type == 'bug') ...[
          const SizedBox(height: 8),
          if (_showSteps) ...[
            Text(L('复现步骤（可选）', 'Steps to reproduce (optional)'), style: label),
            const SizedBox(height: 6),
            TextField(
              controller: _steps,
              minLines: 3,
              maxLines: 8,
              style: TextStyle(fontSize: Fs.prose, color: c.text),
              decoration: field(
                L(
                  '1. 先做什么\n2. 再做什么\n3. 看到了什么',
                  '1. First, I did…\n2. Then…\n3. And I saw…',
                ),
              ),
            ),
          ] else
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () => setState(() => _showSteps = true),
                icon: const Icon(Icons.add, size: 18),
                label: Text(
                  L('添加复现步骤（可选）', 'Add steps to reproduce (optional)'),
                  style: const TextStyle(fontSize: Fs.meta),
                ),
              ),
            ),
        ],
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(
              child: Text(
                L(
                  '截图（最多 ${FeedbackLimits.images} 张）',
                  'Screenshots (up to ${FeedbackLimits.images})',
                ),
                style: label,
              ),
            ),
            TextButton.icon(
              onPressed:
                  _images.busy || _images.images.length >= FeedbackLimits.images
                  ? null
                  : () async {
                      final e = await pickImagesInto(context, _images);
                      if (e != null && mounted) setState(() => _error = e);
                    },
              icon: const Icon(Icons.add_photo_alternate_outlined, size: 18),
              label: Text(
                L('添加', 'Add'),
                style: const TextStyle(fontSize: Fs.meta),
              ),
            ),
          ],
        ),
        if (_images.images.isNotEmpty || _images.busy)
          ImageThumbs(images: _images),
        if (_images.error != null) ToolNote(_images.error!),
        const SizedBox(height: 14),
        GroupTitle(
          L('附带信息（勾选的会一起发送）', 'Attached info (checked items are sent)'),
        ),
        Group(
          children: [
            ListRow(
              leading: Icon(Icons.smartphone, color: c.textMuted),
              title: L('手机信息', 'Phone info'),
              subtitle: _phone.isEmpty ? '…' : _phone,
              trailing: Icon(Icons.check, color: c.accent),
            ),
            CheckboxListTile(
              value: _diagnostics,
              onChanged: (v) => setState(() => _diagnostics = v == true),
              title: Text(
                L('电脑诊断信息', 'Computer diagnostics'),
                style: TextStyle(fontSize: Fs.prose, color: c.text),
              ),
              subtitle: Text(
                L(
                  '版本、系统、各引擎的状态；不含路径',
                  'Version, system, engine status; no paths',
                ),
                style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
              ),
            ),
            CheckboxListTile(
              value: _logs,
              onChanged: (v) => setState(() => _logs = v == true),
              title: Text(
                L('电脑最近 2 小时的日志', "Computer's logs from the last 2 hours"),
                style: TextStyle(fontSize: Fs.prose, color: c.text),
              ),
              subtitle: Text(
                logs == null
                    ? L('已脱敏，不含对话内容', 'Redacted, no conversation content')
                    : L(
                        '${logs['lines']} 行 · ${fileSize((logs['bytes'] as num?)?.toInt() ?? 0)} · 已脱敏',
                        '${logs['lines']} lines · ${fileSize((logs['bytes'] as num?)?.toInt() ?? 0)} · redacted',
                      ),
                style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
              ),
            ),
            CheckboxListTile(
              value: _phoneLog,
              onChanged: (v) => setState(() => _phoneLog = v == true),
              title: Text(
                L('手机最近 2 小时的日志', "This phone's log from the last 2 hours"),
                style: TextStyle(fontSize: Fs.prose, color: c.text),
              ),
              subtitle: Text(
                L(
                  '${recentLogs(appLog.entries, feedbackLogWindow).length} 条 · 只有事件和错误，不含消息内容',
                  '${recentLogs(appLog.entries, feedbackLogWindow).length} ${recentLogs(appLog.entries, feedbackLogWindow).length == 1 ? 'entry' : 'entries'} · events and errors only, no message content',
                ),
                style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
              ),
            ),
          ],
        ),
        Row(
          children: [
            TextButton(
              onPressed: _previewing
                  ? null
                  : () async {
                      if (_preview == null) await _loadPreview();
                      if (mounted) {
                        setState(() => _showDiagnostics = !_showDiagnostics);
                      }
                    },
              child: Text(
                _showDiagnostics
                    ? L('收起诊断信息', 'Hide diagnostics')
                    : L('查看诊断信息', 'View diagnostics'),
                style: const TextStyle(fontSize: Fs.meta),
              ),
            ),
            TextButton(
              onPressed: _previewing
                  ? null
                  : () async {
                      if (_preview == null) await _loadPreview();
                      if (mounted) setState(() => _showLogs = !_showLogs);
                    },
              child: Text(
                _showLogs ? L('收起日志', 'Hide logs') : L('预览日志', 'Preview logs'),
                style: const TextStyle(fontSize: Fs.meta),
              ),
            ),
            if (_previewing)
              const SizedBox.square(
                dimension: 14,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
          ],
        ),
        if (_showDiagnostics && _preview != null)
          _RawText(str(_preview!['diagnosticsText']) ?? ''),
        if (_showLogs && logs != null) ...[
          if (logs['cut'] == true)
            ToolNote(
              L(
                '只显示最后一段；提交时电脑会发完整的。',
                'Only the last part is shown; the computer sends the full logs.',
              ),
            ),
          _RawText(str(logs['text']) ?? ''),
        ],
      ],
    );
  }
}

/// 将要发送的原文：等宽、可选中、限高可滚
class _RawText extends StatelessWidget {
  const _RawText(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      constraints: const BoxConstraints(maxHeight: 320),
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: c.bgSubtle,
        borderRadius: BorderRadius.circular(Radii.code),
      ),
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(12),
        child: SelectableText(
          text,
          style: TextStyle(
            fontSize: Fs.label,
            height: 1.5,
            fontFamily: 'monospace',
            color: c.textSecondary,
          ),
        ),
      ),
    );
  }
}
