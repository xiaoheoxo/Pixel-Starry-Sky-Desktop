// 输入框（布局参考 DSH Go，docs/mobile-app.md §8.1）：一张浮起来的圆角卡片——有图片时上面先是缩略图，
// 下面一行：圆形「＋」（相册 / 拍照）、输入框、右边一个圆键。
// 圆键：运行中且没字没图是方形「停止」；其余是发送（运行中发的由电脑排队，docs/ui/message-queue.md）。
// 草稿由外面管（会话页的 TextEditingController）：队列里撤回的消息会放回这里。规则照网页版 Composer.tsx。
import 'package:image_picker/image_picker.dart';
import 'package:material_ui/material_ui.dart';

import '../../data/actions.dart';
import '../../data/images.dart';
import '../../i18n/i18n.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';

class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.draft,
    required this.canAct,
    required this.running,
    required this.engineName,
    required this.onSend,
    this.onStop,
    this.images,
    this.autofocus = false,
    this.placeholder,
    this.top,
  });

  final TextEditingController draft;
  final bool canAct;

  /// 会话页算好的「正在跑」（含启动中）
  final bool running;
  final String engineName;

  /// 发出去；失败抛出（错误显示在输入框上面）
  final Future<void> Function(String text, List<Attachment> images) onSend;
  final Future<void> Function()? onStop;

  /// 待发的图片；null 时不能加图
  final PendingImages? images;
  final bool autofocus;
  final String? placeholder;

  /// 卡片里输入行上面的一行（会话页运行中的「正在回复 0:12」）
  final Widget? top;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  bool _busy = false;
  String? _error;
  final _picker = ImagePicker();

  @override
  void initState() {
    super.initState();
    widget.draft.addListener(_changed);
    widget.images?.addListener(_changed);
  }

  @override
  void dispose() {
    widget.draft.removeListener(_changed);
    widget.images?.removeListener(_changed);
    super.dispose();
  }

  void _changed() => setState(() {});

  List<Attachment> get _images => widget.images?.images ?? const [];

  bool get _ready =>
      widget.canAct &&
      (widget.draft.text.trim().isNotEmpty || _images.isNotEmpty) &&
      !_busy &&
      !(widget.images?.busy ?? false);

  Future<void> _send() async {
    final sent = widget.draft.text;
    final value = sent.trim();
    final images = List<Attachment>.of(_images);
    if (value.isEmpty && images.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.onSend(value, images);
      // 发送中又输入了新的话：只清掉发出去的那句
      if (widget.draft.text == sent) widget.draft.clear();
      widget.images?.discard([for (final i in images) i['id'] as String]);
    } catch (e) {
      if (mounted) setState(() => _error = actionError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pick() async {
    final images = widget.images;
    if (images == null) return;
    final source = await showPanel<ImageSource>(
      context,
      (context) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Section(
            children: [
              ListRow(
                leading: const Icon(Icons.photo_library_outlined),
                title: L('从相册选', 'Choose from photos'),
                onTap: () => Navigator.pop(context, ImageSource.gallery),
              ),
              ListRow(
                leading: const Icon(Icons.photo_camera_outlined),
                title: L('拍照', 'Take a photo'),
                onTap: () => Navigator.pop(context, ImageSource.camera),
              ),
            ],
          ),
        ),
      ),
    );
    if (source == null) return;
    try {
      final files = source == ImageSource.gallery
          ? await _picker.pickMultiImage(limit: maxImages)
          : [?await _picker.pickImage(source: ImageSource.camera)];
      if (files.isNotEmpty) await images.add(files);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final images = widget.images;
    final stopping =
        widget.running &&
        widget.draft.text.trim().isEmpty &&
        _images.isEmpty &&
        widget.onStop != null;
    final error = _error ?? images?.error;
    final placeholder =
        widget.placeholder ??
        (!widget.canAct
            ? L('连上电脑后才能发消息，写好的字会留着', 'Connect to send. Your draft is kept.')
            : widget.running
            ? L('正在回复 · 现在发会排在后面', 'Replying · new messages are queued')
            : L('给 ${widget.engineName} 发消息', 'Message ${widget.engineName}'));
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(6, 0, 6, 6),
              child: Text(
                error,
                style: TextStyle(fontSize: Fs.meta, color: c.danger),
              ),
            ),
          Container(
            padding: const EdgeInsets.all(5),
            decoration: BoxDecoration(
              color: c.bgSurface,
              borderRadius: BorderRadius.circular(Radii.composer + 4),
              border: Border.all(color: c.borderComposer),
              boxShadow: [
                BoxShadow(
                  color: c.ink.withValues(alpha: 0.06),
                  blurRadius: 16,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                ?widget.top,
                if (_images.isNotEmpty || (images?.busy ?? false))
                  _Thumbs(images: images!),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    _Circle(
                      icon: Icons.add,
                      tooltip: L('加图片', 'Add images'),
                      onTap: images == null || !widget.canAct || _busy
                          ? null
                          : _pick,
                      filled: false,
                    ),
                    Expanded(
                      child: TextField(
                        controller: widget.draft,
                        autofocus: widget.autofocus,
                        enabled: widget.canAct,
                        minLines: 1,
                        maxLines: 6,
                        keyboardType: TextInputType.multiline,
                        textCapitalization: TextCapitalization.sentences,
                        style: TextStyle(
                          fontSize: Fs.prose,
                          height: 1.4,
                          color: c.text,
                        ),
                        decoration: InputDecoration(
                          isDense: true,
                          filled: false,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          disabledBorder: InputBorder.none,
                          contentPadding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 8,
                          ),
                          hintText: placeholder,
                          hintMaxLines: 1,
                          hintStyle: TextStyle(
                            color: c.textFaint,
                            fontSize: Fs.prose,
                          ),
                        ),
                      ),
                    ),
                    if (stopping)
                      _Circle(
                        icon: Icons.stop_rounded,
                        tooltip: L('停止', 'Stop'),
                        onTap: widget.canAct ? () => widget.onStop!() : null,
                        filled: true,
                      )
                    else
                      _Circle(
                        icon: widget.running
                            ? Icons.playlist_add
                            : Icons.arrow_upward,
                        tooltip: widget.running
                            ? L('排队发送', 'Queue message')
                            : L('发送', 'Send'),
                        onTap: _ready ? _send : null,
                        filled: true,
                        busy: _busy,
                      ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Circle extends StatelessWidget {
  const _Circle({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    required this.filled,
    this.busy = false,
  });
  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;
  final bool filled;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final on = onTap != null;
    final bg = filled ? (on ? c.btnPrimaryBg : c.bgSubtle) : c.bgSubtle;
    final fg = filled
        ? (on ? c.btnPrimaryText : c.textFaint)
        : (on ? c.text : c.textFaint);
    return Tooltip(
      message: tooltip,
      child: Material(
        color: bg,
        shape: const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: SizedBox.square(
            dimension: 36,
            child: busy
                ? Padding(
                    padding: const EdgeInsets.all(10),
                    child: CircularProgressIndicator(strokeWidth: 2, color: fg),
                  )
                : Icon(icon, size: 20, color: fg),
          ),
        ),
      ),
    );
  }
}

class _Thumbs extends StatelessWidget {
  const _Thumbs({required this.images});
  final PendingImages images;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SizedBox(
      height: 72,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 4),
        children: [
          for (final img in images.images)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.memory(
                      imageBytes(img),
                      width: 64,
                      height: 64,
                      fit: BoxFit.cover,
                      gaplessPlayback: true,
                    ),
                  ),
                  Positioned(
                    top: -6,
                    right: -6,
                    child: GestureDetector(
                      onTap: () => images.remove(img['id'] as String),
                      child: Container(
                        decoration: BoxDecoration(
                          color: c.btnPrimaryBg,
                          shape: BoxShape.circle,
                        ),
                        padding: const EdgeInsets.all(3),
                        child: Icon(
                          Icons.close,
                          size: 14,
                          color: c.btnPrimaryText,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (images.busy)
            SizedBox(
              width: 64,
              child: Center(
                child: SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: c.textMuted,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
