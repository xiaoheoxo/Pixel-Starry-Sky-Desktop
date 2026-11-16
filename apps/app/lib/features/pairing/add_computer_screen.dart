// 连上你的电脑：扫二维码，或粘贴配对链接（照网页版第四轮的「添加电脑」页）
import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';

import '../../connection/offer.dart';
import '../../i18n/i18n.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import 'pair_screen.dart';
import 'scan_screen.dart';
import 'texts.dart';

class AddComputerScreen extends StatelessWidget {
  const AddComputerScreen({super.key, this.canClose = false});

  /// 已经有配对过的电脑时，左上角是 ×
  final bool canClose;

  Future<void> _paste(BuildContext context) async {
    final clip = (await Clipboard.getData(Clipboard.kTextPlain))?.text ?? '';
    if (!context.mounted) return;
    final text = await showPanel<String>(
      context,
      (context) => _PastePanel(initial: clip),
    );
    if (text == null || !context.mounted) return;
    openOffer(context, text);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return AppScreen(
      leading: canClose
          ? RoundIconButton(
              icon: Icons.close,
              tooltip: L('关闭', 'Close'),
              onPressed: () => Navigator.of(context).pop(),
            )
          : null,
      body: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                L('连上你的电脑', 'Connect your computer'),
                style: TextStyle(
                  fontSize: Fs.title,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.56,
                  color: c.text,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                L(
                  '在电脑上打开像素星空 › 设置 › 手机 › 添加手机，扫屏幕上的二维码。代码和账号都留在电脑上，手机只是遥控器。',
                  'On your computer, open PixelSky › Settings › Phone › Add a phone and scan the QR code. Your code and accounts stay on the computer; the phone is just a remote.',
                ),
                style: TextStyle(
                  fontSize: Fs.ui,
                  height: 1.6,
                  color: c.textSecondary,
                ),
              ),
              const Spacer(),
              Center(
                child: Container(
                  width: 200,
                  height: 200,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(Radii.panel),
                    border: Border.all(color: c.border, width: 2),
                  ),
                  child: Icon(Icons.qr_code_2, size: 96, color: c.textFaint),
                ),
              ),
              const Spacer(),
              PrimaryButton(
                label: L('扫二维码', 'Scan QR code'),
                icon: Icons.qr_code_scanner,
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(builder: (_) => const ScanScreen()),
                ),
              ),
              const SizedBox(height: 12),
              SecondaryButton(
                label: L('粘贴配对链接', 'Paste pairing link'),
                icon: Icons.content_paste,
                onPressed: () => _paste(context),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 解析配对文字，打开确认页；不对时提示
void openOffer(BuildContext context, String text, {bool replace = false}) {
  final Offer offer;
  try {
    offer = findOffer(text);
  } on OfferException catch (e) {
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(offerErrorText(e.error))));
    return;
  }
  final route = MaterialPageRoute<void>(
    builder: (_) => PairScreen(offer: offer),
  );
  if (replace) {
    Navigator.of(context).pushReplacement(route);
  } else {
    Navigator.of(context).push(route);
  }
}

class _PastePanel extends StatefulWidget {
  const _PastePanel({required this.initial});
  final String initial;
  @override
  State<_PastePanel> createState() => _PastePanelState();
}

class _PastePanelState extends State<_PastePanel> {
  late final _text = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            L('粘贴配对链接', 'Paste pairing link'),
            style: TextStyle(
              fontSize: Fs.section,
              fontWeight: FontWeight.w600,
              color: c.text,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            L(
              '在电脑的 设置 › 手机 › 添加手机 里点「复制配对链接」',
              'On your computer: Settings › Phone › Add a phone › Copy pairing link',
            ),
            style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _text,
            autofocus: widget.initial.isEmpty,
            minLines: 3,
            maxLines: 6,
            decoration: InputDecoration(
              filled: true,
              fillColor: c.bgSubtle,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(Radii.card),
                borderSide: BorderSide.none,
              ),
              hintText: 'https://…/m/#pair=…',
            ),
          ),
          const SizedBox(height: 16),
          PrimaryButton(
            label: L('下一步', 'Next'),
            onPressed: () => Navigator.of(context).pop(_text.text),
          ),
        ],
      ),
    );
  }
}
