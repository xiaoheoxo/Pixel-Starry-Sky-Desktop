// 扫码：认出配对链接（网页链接或 pixelsky://）就打开确认页
import 'package:material_ui/material_ui.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../i18n/i18n.dart';
import '../../ui/widgets.dart';
import 'add_computer_screen.dart';

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});
  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final _controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
  );
  bool _done = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_done) return;
    for (final code in capture.barcodes) {
      final text = code.rawValue;
      if (text == null ||
          !(text.contains('#pair=') || text.startsWith('pixelsky://'))) {
        continue;
      }
      _done = true;
      openOffer(context, text, replace: true);
      return;
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScreen(
      title: L('扫二维码', 'Scan QR code'),
      leading: RoundIconButton(
        icon: Icons.close,
        tooltip: L('关闭', 'Close'),
        onPressed: () => Navigator.of(context).pop(),
      ),
      body: Stack(
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: _onDetect,
            errorBuilder: (context, error) => EmptyState(
              icon: Icons.no_photography_outlined,
              title: L('打不开相机', 'Can’t open the camera'),
              body: L(
                '请在系统设置里允许像素星空使用相机，或者回上一页粘贴配对链接。',
                'Allow camera access for PixelSky in system settings, or go back and paste the pairing link.',
              ),
            ),
          ),
          Center(
            child: Container(
              width: 240,
              height: 240,
              decoration: BoxDecoration(
                border: Border.all(color: Colors.white, width: 3),
                borderRadius: BorderRadius.circular(24),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
