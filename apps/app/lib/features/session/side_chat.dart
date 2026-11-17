// 旁聊（docs/mobile-app.md §15.3）：不打断正在跑的这一轮问一句。电脑上一次问一次答（返回整段文字），
// 之前的问答由手机带上；记录只在手机内存里，关掉面板还在，离开这个会话页才清掉，不进对话。
import 'package:material_ui/material_ui.dart';

import '../../data/actions.dart';
import '../../i18n/i18n.dart';
import '../../ui/markdown.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';

/// 一个会话页的旁聊记录：会话页持有，关掉面板不丢
class SideChat extends ChangeNotifier {
  final List<SideTurn> turns = [];

  /// 正在问的那一句（还没回答）
  String? asking;
  String? error;

  Future<void> ask(SessionActions actions, String question) async {
    if (asking != null) return;
    asking = question;
    error = null;
    notifyListeners();
    try {
      final answer = await actions.sideQuestion(question, List.of(turns));
      // 停掉了（asking 被清掉）就不记这一轮
      if (asking == question) {
        turns.add((question: question, answer: answer));
      }
    } catch (e) {
      if (asking == question) error = actionError(e);
    } finally {
      if (asking == question) asking = null;
      notifyListeners();
    }
  }

  Future<void> stop(SessionActions actions) async {
    if (asking == null) return;
    asking = null;
    notifyListeners();
    try {
      await actions.cancelSideQuestion();
    } catch (_) {
      // 电脑那边已经答完或断开了，手机上已经不等了
    }
  }
}

Future<void> showSideChat(
  BuildContext context, {
  required SideChat chat,
  required SessionActions actions,
}) => showPanel<void>(
  context,
  (_) => _SideChatSheet(chat: chat, actions: actions),
);

class _SideChatSheet extends StatefulWidget {
  const _SideChatSheet({required this.chat, required this.actions});
  final SideChat chat;
  final SessionActions actions;

  @override
  State<_SideChatSheet> createState() => _SideChatSheetState();
}

class _SideChatSheetState extends State<_SideChatSheet> {
  final _input = TextEditingController();
  final _scroll = ScrollController();

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send() {
    final text = _input.text.trim();
    if (text.isEmpty || widget.chat.asking != null) return;
    _input.clear();
    widget.chat.ask(widget.actions, text);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.7,
      child: ListenableBuilder(
        listenable: widget.chat,
        builder: (context, _) {
          final chat = widget.chat;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (_scroll.hasClients) {
              _scroll.jumpTo(_scroll.position.maxScrollExtent);
            }
          });
          return Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Text(
                      L('旁聊', 'Side chat'),
                      style: TextStyle(
                        fontSize: Fs.section,
                        fontWeight: FontWeight.w600,
                        color: c.text,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: c.bgSubtle,
                        borderRadius: BorderRadius.circular(99),
                      ),
                      child: Text(
                        L('不打断这一轮', "Doesn't interrupt"),
                        style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  L(
                    '问答不进对话，离开这个会话页后清掉。',
                    'Not added to the conversation; cleared when you leave this page.',
                  ),
                  style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                ),
                const SizedBox(height: 8),
                Expanded(
                  child: ListView(
                    controller: _scroll,
                    children: [
                      for (final t in chat.turns) ...[
                        _Question(t.question),
                        ReplyMarkdown(t.answer),
                        const SizedBox(height: 8),
                      ],
                      if (chat.asking != null) ...[
                        _Question(chat.asking!),
                        Text(
                          L('正在想…', 'Thinking…'),
                          style: TextStyle(fontSize: Fs.ui, color: c.textMuted),
                        ),
                      ],
                      if (chat.error != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            chat.error!,
                            style: TextStyle(
                              fontSize: Fs.meta,
                              color: c.danger,
                            ),
                          ),
                        ),
                      if (chat.turns.isEmpty &&
                          chat.asking == null &&
                          chat.error == null)
                        Padding(
                          padding: const EdgeInsets.only(top: 24),
                          child: Text(
                            L(
                              '它知道这个对话到目前为止的内容，可以问问它在做什么、某段代码什么意思。',
                              'It knows the conversation so far — ask what it is doing or what some code means.',
                            ),
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: Fs.ui,
                              color: c.textMuted,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _input,
                        minLines: 1,
                        maxLines: 4,
                        enabled: widget.actions.canAct,
                        textInputAction: TextInputAction.send,
                        onSubmitted: (_) => _send(),
                        decoration: InputDecoration(
                          hintText: widget.actions.canAct
                              ? L('问一句…', 'Ask something…')
                              : L(
                                  '没连上电脑，或这部手机是「只看」',
                                  'Not connected, or this phone is “View only”',
                                ),
                          isDense: true,
                          border: OutlineInputBorder(
                            borderRadius: BorderRadius.circular(20),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    chat.asking != null
                        ? IconButton.filled(
                            tooltip: L('停止', 'Stop'),
                            style: IconButton.styleFrom(
                              backgroundColor: c.danger,
                            ),
                            onPressed: () => chat.stop(widget.actions),
                            icon: const Icon(Icons.stop_rounded),
                          )
                        : IconButton.filled(
                            tooltip: L('问', 'Ask'),
                            onPressed: widget.actions.canAct ? _send : null,
                            icon: const Icon(Icons.arrow_upward_rounded),
                          ),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _Question extends StatelessWidget {
  const _Question(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.only(bottom: 6, left: 40),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: c.bgSelected,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Text(
          text,
          style: TextStyle(fontSize: Fs.ui, color: c.text),
        ),
      ),
    );
  }
}
