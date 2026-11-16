// 确认配对：核对电脑名和指纹 → 起手机名 → 换令牌 → 等电脑上点「允许」→ 连上后回到首页
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../connection/desktop_link.dart';
import '../../connection/offer.dart';
import '../../connection/pair.dart';
import '../../connection/pairing.dart';
import '../../i18n/i18n.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import 'texts.dart';

/// 手机名的默认值：机型（Pixel 8、iPhone15,2…）
Future<String> defaultPhoneName() async {
  try {
    final info = DeviceInfoPlugin();
    if (Platform.isAndroid) {
      final a = await info.androidInfo;
      return '${a.manufacturer} ${a.model}'.trim();
    }
    if (Platform.isIOS) return (await info.iosInfo).name;
  } catch (_) {
    // 拿不到就用通用名字
  }
  return L('我的手机', 'My phone');
}

class PairScreen extends StatefulWidget {
  const PairScreen({super.key, required this.offer});
  final Offer offer;
  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _name = TextEditingController();
  bool _busy = false;
  String? _error;

  /// 换到令牌之后的配对记录：之后看它的连接状态
  Pairing? _pairing;

  @override
  void initState() {
    super.initState();
    defaultPhoneName().then((n) {
      if (mounted && _name.text.isEmpty) _name.text = n;
    });
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _pair() async {
    final services = AppScope.read(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final name = _name.text.trim().isEmpty
          ? L('我的手机', 'My phone')
          : _name.text.trim();
      final p = await pairWithOffer(widget.offer, name, services.api);
      await services.connections.add(p);
      if (mounted) setState(() => _pairing = p);
    } on PairException catch (e) {
      if (mounted) setState(() => _error = pairErrorText(e.error));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final services = AppScope.of(context);
    final pairing = _pairing;
    final state = pairing == null
        ? null
        : services.connections.state(pairing.deviceId);
    if (state == LinkState.ready) {
      // 连上了：回到首页（首页按配对列表显示会话）
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
      });
    }
    return AppScreen(
      leading: RoundIconButton(
        icon: Icons.close,
        tooltip: L('关闭', 'Close'),
        onPressed: () => Navigator.of(context).pop(),
      ),
      body: SafeArea(
        top: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          children: [
            Text(
              pairing == null
                  ? L('连接这台电脑？', 'Connect to this computer?')
                  : L('等电脑确认', 'Waiting for the computer'),
              style: TextStyle(
                fontSize: Fs.title,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.56,
                color: c.text,
              ),
            ),
            const SizedBox(height: 16),
            Section(
              children: [
                ListRow(
                  title: widget.offer.desktopName,
                  subtitle:
                      L('电脑指纹 ', 'Computer fingerprint ') +
                      widget.offer.fingerprint,
                  leading: Icon(Icons.computer, color: c.textSecondary),
                ),
                if (pairing != null)
                  ListRow(
                    title: L('这部手机的指纹', 'This phone’s fingerprint'),
                    subtitle: phoneFingerprint(pairing),
                    leading: Icon(Icons.smartphone, color: c.textSecondary),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              L(
                '和电脑屏幕上显示的指纹对一下，一样才是你的电脑。',
                'Check that it matches the fingerprint on your computer.',
              ),
              style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
            ),
            const SizedBox(height: 24),
            if (pairing == null) ...[
              Text(
                L('手机名字', 'Phone name'),
                style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
              ),
              const SizedBox(height: 6),
              TextField(
                controller: _name,
                maxLength: 64,
                decoration: InputDecoration(
                  filled: true,
                  fillColor: c.bgSubtle,
                  counterText: '',
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(Radii.card),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
              const SizedBox(height: 6),
              Text(
                L(
                  '电脑上会显示这个名字，方便你认出是哪部手机。',
                  'Shown on your computer so you can tell which phone this is.',
                ),
                style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
              ),
              if (_error != null) ...[
                const SizedBox(height: 16),
                Text(
                  _error!,
                  style: TextStyle(color: c.danger, fontSize: Fs.list),
                ),
              ],
              const SizedBox(height: 24),
              PrimaryButton(
                label: L('连接', 'Connect'),
                busy: _busy,
                onPressed: widget.offer.expired ? null : _pair,
              ),
            ] else ...[
              Row(
                children: [
                  if (state != LinkState.removed)
                    SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: c.textMuted,
                      ),
                    ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      linkStateText(state) ?? '',
                      style: TextStyle(
                        fontSize: Fs.prose,
                        color: state == LinkState.removed ? c.danger : c.text,
                      ),
                    ),
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
