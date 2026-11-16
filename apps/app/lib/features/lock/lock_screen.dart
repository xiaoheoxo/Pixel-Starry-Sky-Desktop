// 面容 / 指纹锁（A3，可选，默认关）：打开 App、离开超过 1 分钟回来时盖住所有页面，验证过才放行。
// 用系统的验证（local_auth）：有面容 / 指纹用它，没有时可以用锁屏密码。
import 'package:local_auth/local_auth.dart';
import 'package:material_ui/material_ui.dart';

import '../../i18n/i18n.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';

/// 系统验证；成功返回 true。系统没设锁屏、取消、出错都是 false
Future<bool> authenticate(String reason) async {
  try {
    return await LocalAuthentication().authenticate(
      localizedReason: reason,
      persistAcrossBackgrounding: true,
    );
  } catch (_) {
    return false;
  }
}

/// 这台手机能不能用（设了锁屏密码 / 面容 / 指纹）
Future<bool> canAuthenticate() async {
  try {
    return await LocalAuthentication().isDeviceSupported();
  } catch (_) {
    return false;
  }
}

class LockScreen extends StatefulWidget {
  const LockScreen({super.key, required this.onUnlocked});
  final VoidCallback onUnlocked;

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _unlock());
  }

  Future<void> _unlock() async {
    if (_busy) return;
    setState(() => _busy = true);
    final ok = await authenticate(L('解锁像素星空', 'Unlock PixelSky'));
    if (!mounted) return;
    setState(() => _busy = false);
    if (ok) widget.onUnlocked();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Material(
      color: c.bgWorkbench,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            children: [
              const Spacer(),
              Icon(Icons.lock_outline, size: 48, color: c.textMuted),
              const SizedBox(height: 16),
              Text(
                L('像素星空已锁定', 'PixelSky is locked'),
                style: TextStyle(
                  fontSize: Fs.section,
                  fontWeight: FontWeight.w600,
                  color: c.text,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                L(
                  '用面容、指纹或锁屏密码解锁',
                  'Unlock with face, fingerprint, or your screen lock',
                ),
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: Fs.list, color: c.textMuted),
              ),
              const Spacer(),
              PrimaryButton(
                label: L('解锁', 'Unlock'),
                icon: Icons.fingerprint,
                busy: _busy,
                onPressed: _unlock,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
