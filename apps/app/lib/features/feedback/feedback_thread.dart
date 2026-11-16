// 一条反馈（docs/mobile-app.md §8.5，照电脑 docs/ui/feedback.md §2.2）：消息流（你 / 像素星空团队 / 关闭、重新打开的一行事件），
// 附件点开看（截图、日志文字）；底部补充框（可带截图），「关闭反馈」确认后关。已关闭的发补充会重新打开。
// 打开就算看过（电脑那边记已读）；电脑说反馈变了（新回复）时重取。
import 'dart:convert';
import 'dart:typed_data';

import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../data/feedback.dart';
import '../../data/images.dart';
import '../../data/tasks.dart' show Tone, ago;
import '../../data/tools.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/image_attach.dart';
import '../../ui/markdown.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../session/approval_card.dart' show confirm;
import '../tools/common.dart';
import 'feedback_screen.dart' show FeedbackStatusChip;

class FeedbackThreadScreen extends StatefulWidget {
  const FeedbackThreadScreen({
    super.key,
    required this.deviceId,
    required this.threadId,
    required this.title,
    this.initial,
  });
  final String deviceId;
  final String threadId;
  final String title;

  /// 刚提交完：先显示提交返回的，不用再取
  final Json? initial;
  @override
  State<FeedbackThreadScreen> createState() => _FeedbackThreadScreenState();
}

class _FeedbackThreadScreenState extends State<FeedbackThreadScreen> {
  late final _services = AppScope.read(context);
  late final ToolData _detail = ToolData(
    _services.connections,
    widget.deviceId,
    'feedback:get',
    [widget.threadId],
  );
  final _reply = TextEditingController();
  final _images = PendingImages();
  bool _busy = false;
  String? _error;
  late int _version = _services.feedback?.version(widget.deviceId) ?? 0;

  @override
  void initState() {
    super.initState();
    if (widget.initial != null) _detail.set(widget.initial);
    _services.feedback?.addListener(_onChanged);
    _reply.addListener(_changed);
    _images.addListener(_changed);
  }

  @override
  void dispose() {
    _services.feedback?.removeListener(_onChanged);
    _detail.dispose();
    _reply.dispose();
    _images.dispose();
    super.dispose();
  }

  void _changed() => setState(() {});

  void _onChanged() {
    final v = _services.feedback?.version(widget.deviceId) ?? 0;
    if (v == _version) return;
    _version = v;
    _detail.reload();
  }

  Future<void> _write(String method, List<Object?> args) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await callTool(
        _services.connections,
        widget.deviceId,
        method,
        args,
      );
      if (!mounted) return;
      _detail.set(r);
      if (method == 'feedback:reply') {
        _reply.clear();
        _images.discard([for (final i in _images.images) i['id'] as String]);
        FocusScope.of(context).unfocus();
      }
    } catch (e) {
      if (mounted) setState(() => _error = feedbackError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _send() async {
    final limit = replyLimitError(
      body: _reply.text,
      images: _images.images.length,
    );
    if (limit != null) {
      setState(() => _error = limit);
      return;
    }
    await _write('feedback:reply', [
      widget.threadId,
      {
        'body': _reply.text.trim(),
        'diagnostics': false,
        'logs': null,
        'images': feedbackImages(_images.images),
      },
    ]);
  }

  Future<void> _close() async {
    final ok = await confirm(
      context,
      L(
        '关闭这条反馈？以后发补充会重新打开它。',
        'Close this feedback? Sending a follow-up later reopens it.',
      ),
      ok: L('关闭反馈', 'Close feedback'),
    );
    if (ok && mounted) await _write('feedback:close', [widget.threadId]);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListenableBuilder(
      listenable: Listenable.merge([_detail, _services.connections]),
      builder: (context, _) {
        final d = objOrNull(_detail.data);
        final thread = d == null ? null : FeedbackSummary(obj(d['thread']));
        final messages = [
          for (final m in objList(d?['messages'])) FeedbackMessage(m),
        ];
        final closed = thread?.status == 'closed';
        final canAct = canActOn(_services.connections, widget.deviceId);
        return ToolFrame(
          title: L('反馈', 'Feedback'),
          heading: thread?.title ?? widget.title,
          crumb: thread == null
              ? null
              : Row(
                  children: [
                    Text(feedbackTypeText(thread.type)),
                    const SizedBox(width: 8),
                    FeedbackStatusChip(feedbackStatusKind(thread)),
                  ],
                ),
          loading: _detail.loading,
          onRefresh: _detail.reload,
          footer: d != null && canAct ? _footer(closed) : null,
          children: [
            if (_error != null) ToolBanner(_error!, tone: Tone.danger),
            if (d == null)
              ToolLoading(
                error: _detail.error == null
                    ? null
                    : feedbackError(_detail.error!),
              )
            else
              for (final m in messages)
                if (m.kind == 'message')
                  _Bubble(
                    message: m,
                    deviceId: widget.deviceId,
                    threadId: widget.threadId,
                  )
                else
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Text(
                      '${m.kind == 'closed' ? (m.author == 'team' ? L('团队关闭了此反馈', 'The team closed this') : L('你关闭了此反馈', 'You closed this')) : L('重新打开了', 'Reopened')} · ${ago(m.createdAt)}',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
                    ),
                  ),
          ],
        );
      },
    );
  }

  Widget _footer(bool closed) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
        decoration: BoxDecoration(
          color: c.bgSurface,
          borderRadius: BorderRadius.circular(Radii.card),
          border: Border.all(color: c.borderComposer),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (closed)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  L(
                    '发送补充会重新打开这条反馈',
                    'Sending a follow-up reopens this feedback',
                  ),
                  style: TextStyle(fontSize: Fs.label, color: c.textFaint),
                ),
              ),
            if (_images.images.isNotEmpty || _images.busy)
              ImageThumbs(images: _images),
            TextField(
              controller: _reply,
              minLines: 1,
              maxLines: 5,
              style: TextStyle(fontSize: Fs.prose, color: c.text),
              decoration: InputDecoration(
                isDense: true,
                border: InputBorder.none,
                hintText: L('补充说明…', 'Add a follow-up…'),
                hintStyle: TextStyle(color: c.textFaint),
              ),
            ),
            Row(
              children: [
                IconButton(
                  tooltip: L('添加截图', 'Add screenshots'),
                  onPressed:
                      _busy ||
                          _images.busy ||
                          _images.images.length >= FeedbackLimits.images
                      ? null
                      : () async {
                          final e = await pickImagesInto(context, _images);
                          if (e != null && mounted) setState(() => _error = e);
                        },
                  icon: Icon(
                    Icons.add_photo_alternate_outlined,
                    color: c.textMuted,
                  ),
                ),
                if (!closed)
                  TextButton(
                    onPressed: _busy ? null : _close,
                    child: Text(
                      L('关闭反馈', 'Close feedback'),
                      style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                    ),
                  ),
                const Spacer(),
                FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: c.btnPrimaryBg,
                    foregroundColor: c.btnPrimaryText,
                    shape: const StadiumBorder(),
                  ),
                  onPressed: _busy || _images.busy || _reply.text.trim().isEmpty
                      ? null
                      : _send,
                  child: Text(
                    _busy ? L('正在发送…', 'Sending…') : L('发送补充', 'Send'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// 一条消息：你的靠左灰底，团队的靠右浅强调色底；附件在正文下面
class _Bubble extends StatelessWidget {
  const _Bubble({
    required this.message,
    required this.deviceId,
    required this.threadId,
  });
  final FeedbackMessage message;
  final String deviceId;
  final String threadId;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final team = message.author == 'team';
    return Align(
      alignment: team ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: EdgeInsets.only(
          bottom: 12,
          left: team ? 32 : 0,
          right: team ? 0 : 32,
        ),
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
        decoration: BoxDecoration(
          color: team ? c.accent.withValues(alpha: 0.08) : c.bgSubtle,
          borderRadius: BorderRadius.circular(Radii.card),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${team ? L('像素星空团队', 'PixelSky team') : L('你', 'You')} · ${ago(message.createdAt)}',
              style: TextStyle(fontSize: Fs.label, color: c.textMuted),
            ),
            const SizedBox(height: 4),
            ReplyMarkdown(message.body),
            if (message.attachments.isNotEmpty || message.hasDiagnostics) ...[
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  if (message.hasDiagnostics)
                    _Chip(
                      icon: Icons.info_outline,
                      text: L('诊断信息', 'Diagnostics'),
                    ),
                  for (final a in message.attachments)
                    _Chip(
                      icon: a.kind == 'image'
                          ? Icons.image_outlined
                          : Icons.description_outlined,
                      text: a.kind == 'image'
                          ? L('截图', 'Screenshot')
                          : '${L('日志', 'Logs')} ${fileSize(a.rawSize)}',
                      onTap: a.available
                          ? () => Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => _AttachmentPage(
                                  deviceId: deviceId,
                                  threadId: threadId,
                                  attachment: a,
                                ),
                              ),
                            )
                          : null,
                    ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.text, this.onTap});
  final IconData icon;
  final String text;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Radii.pill),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          border: Border.all(color: c.borderCard),
          borderRadius: BorderRadius.circular(Radii.pill),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: c.textMuted),
            const SizedBox(width: 4),
            Text(
              text,
              style: TextStyle(fontSize: Fs.label, color: c.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}

/// 附件：截图看大图，日志看文字（电脑那边太长的截掉了开头）
class _AttachmentPage extends StatefulWidget {
  const _AttachmentPage({
    required this.deviceId,
    required this.threadId,
    required this.attachment,
  });
  final String deviceId;
  final String threadId;
  final FeedbackAttachmentMeta attachment;
  @override
  State<_AttachmentPage> createState() => _AttachmentPageState();
}

class _AttachmentPageState extends State<_AttachmentPage> {
  late final ToolData _data = ToolData(
    AppScope.read(context).connections,
    widget.deviceId,
    'feedback:attachment',
    [widget.threadId, widget.attachment.id],
  );

  @override
  void dispose() {
    _data.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListenableBuilder(
      listenable: _data,
      builder: (context, _) {
        final a = objOrNull(_data.data);
        final image = a?['kind'] == 'image';
        return ToolFrame(
          title: image ? L('截图', 'Screenshot') : L('日志', 'Logs'),
          subtitle: widget.attachment.name,
          loading: _data.loading,
          onRefresh: _data.reload,
          children: [
            if (a == null)
              ToolLoading(
                error: _data.error == null ? null : feedbackError(_data.error!),
              )
            else if (image)
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: Image.memory(
                  _decode(str(a['data'])),
                  errorBuilder: (_, _, _) => EmptyState(
                    icon: Icons.broken_image_outlined,
                    title: L('打不开这张图', "Can't open this image"),
                  ),
                ),
              )
            else ...[
              if (a['cut'] == true)
                ToolNote(
                  L(
                    '日志太长，只显示了最后一段。',
                    'The log is long; only the last part is shown.',
                  ),
                ),
              SelectableText(
                str(a['text']) ?? '',
                style: TextStyle(
                  fontSize: Fs.label,
                  height: 1.5,
                  fontFamily: 'monospace',
                  color: c.textSecondary,
                ),
              ),
            ],
          ],
        );
      },
    );
  }

  static Uint8List _decode(String? data) {
    try {
      return base64Decode(data ?? '');
    } catch (_) {
      return Uint8List(0);
    }
  }
}
