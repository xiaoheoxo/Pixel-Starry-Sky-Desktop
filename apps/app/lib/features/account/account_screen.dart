// 账号与充值（第三批 E1，docs/mobile-app.md §15.13）：借电脑登录的账号看余额、充值、买套餐。
// 下单前确认一次（金额、方式、哪台电脑的账号），开了面容 / 指纹锁时再验证；只有「可操作」的配对能下单。
// 付款：支付宝打开收银台链接（拉起支付宝），微信给付款码存相册（微信扫一扫 → 相册）。
import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart' show RenderRepaintBoundary;
import 'package:gal/gal.dart';
import 'package:material_ui/material_ui.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import 'quota_section.dart';
import '../../app/scope.dart';
import '../../data/actions.dart';
import '../../data/checkout.dart';
import '../../data/tools.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../lock/lock_screen.dart';
import '../settings/log_screen.dart' show showErrorSnack;

void openAccount(BuildContext context, String deviceId) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(builder: (_) => AccountScreen(deviceId: deviceId)),
  );
}

String money(num v, String currency) {
  final s = v == v.roundToDouble()
      ? v.toStringAsFixed(0)
      : v.toStringAsFixed(2);
  return switch (currency.toUpperCase()) {
    'CNY' => '¥$s',
    'USD' => '\$$s',
    _ => '$s $currency',
  };
}

/// 快捷金额：常见的几档里落在范围内的，再加上赠送档位的起点
List<num> quickAmounts(Recharge r) {
  final set = <num>{
    for (final a in const [10, 50, 100, 200, 500])
      if (a >= r.min && (r.max <= 0 || a <= r.max)) a,
    for (final t in r.tiers)
      if (t.minAmount >= r.min && (r.max <= 0 || t.minAmount <= r.max))
        t.minAmount,
  };
  return (set.toList()..sort()).take(6).toList();
}

class AccountScreen extends StatefulWidget {
  const AccountScreen({super.key, required this.deviceId});
  final String deviceId;

  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends State<AccountScreen> {
  late final Checkout _checkout;
  late final ToolData _account;
  Store? _store;
  String? _storeError;
  List<Order> _pending = const [];

  bool _plans = false;
  num? _amount;
  final _custom = TextEditingController();
  int? _planId;
  String? _method;
  bool _busy = false;

  /// 这次下单意图的 id：失败重试、确认账号后再下都用同一个
  String? _requestId;
  String? _intent;

  @override
  void initState() {
    super.initState();
    final connections = AppScope.read(context).connections;
    _checkout = Checkout(connections, widget.deviceId);
    _account = ToolData(connections, widget.deviceId, 'account', const []);
    _load();
  }

  @override
  void dispose() {
    _account.dispose();
    _custom.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final store = await _checkout.store();
      final pending = await _checkout.pending().catchError(
        (Object _) => <Order>[],
      );
      if (!mounted) return;
      setState(() {
        _store = store;
        _storeError = null;
        _pending = pending;
        _method ??= store.methods.isEmpty ? null : store.methods.first.type;
        final quick = quickAmounts(store.recharge);
        _amount ??= quick.isEmpty ? null : quick[quick.length > 1 ? 1 : 0];
      });
    } catch (e) {
      if (mounted) setState(() => _storeError = checkoutError(actionError(e)));
    }
  }

  void _toast(String text) =>
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(text)));

  /// 现在选的：充值金额或套餐、应付多少
  ({double? amount, Plan? plan, num pay})? _choice(Store store) {
    if (_plans) {
      final plan = store.plans.where((p) => p.id == _planId).firstOrNull;
      return plan == null ? null : (amount: null, plan: plan, pay: plan.price);
    }
    final typed = _custom.text.trim();
    final double? amount;
    if (typed.isNotEmpty) {
      amount = checkAmount(typed, store.recharge).value;
    } else {
      amount = _amount?.toDouble();
    }
    if (amount == null) return null;
    return (
      amount: amount,
      plan: null,
      pay: quoteRecharge(store.recharge, amount).pay,
    );
  }

  Future<void> _pay(Store store) async {
    final choice = _choice(store);
    final method = _method;
    if (choice == null || method == null || _busy) return;
    final label = store.methods.firstWhere((m) => m.type == method).label;
    final pairing = AppScope.read(context).connections.pairings
        .where((p) => p.deviceId == widget.deviceId);
    final what = choice.plan?.name ?? L('充值', 'Top-up');
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(L('确认付款', 'Confirm payment')),
        content: Text(
          L(
            '$what · ${money(choice.pay, store.currency)}\n用$label付款，记在「${pairing.isEmpty ? '' : pairing.first.desktopName}」登录的账号上。',
            '$what · ${money(choice.pay, store.currency)}\nPay with $label, charged to the account signed in on “${pairing.isEmpty ? '' : pairing.first.desktopName}”.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(L('取消', 'Cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(L('付款', 'Pay')),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    if (AppScope.read(context).settings.lock &&
        !await authenticate(L('确认付款', 'Confirm payment'))) {
      return;
    }
    // 同一个意图（同金额 / 套餐、同方式）重试时沿用 requestId，云端不会重复下单
    final intent = '${choice.plan?.id}|${choice.amount}|$method';
    if (_intent != intent) {
      _intent = intent;
      _requestId = Checkout.newRequestId();
    }
    setState(() => _busy = true);
    try {
      final order = await _checkout.create(
        requestId: _requestId!,
        method: method,
        amount: choice.amount,
        planId: choice.plan?.id,
      );
      _intent = null;
      if (!mounted) return;
      await _openOrder(order, open: true);
    } catch (e) {
      final code = actionError(e);
      if (code.startsWith('MOBILE_CHECKOUT_PANEL_REAUTH_REQUIRED')) {
        unawaited(_checkout.panelVerify().catchError((Object _) {}));
      }
      if (mounted) _toast(checkoutError(code));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _openOrder(Order order, {bool open = false}) async {
    if (open && order.openUrl != null) {
      unawaited(_launch(order.openUrl!));
    }
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => OrderScreen(checkout: _checkout, order: order),
      ),
    );
    if (mounted) {
      _account.reload();
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListenableBuilder(
      listenable: _account,
      builder: (context, _) {
        final raw = objOrNull(_account.data);
        final account = raw == null ? null : Account(raw);
        final signedOut =
            _account.data == null &&
            !_account.loading &&
            _account.error == null;
        final store = _store;
        return AppScreen(
          title: L('账号与充值', 'Account & top-up'),
          leading: RoundIconButton(
            icon: Icons.arrow_back,
            tooltip: L('返回', 'Back'),
            onPressed: () => Navigator.of(context).pop(),
          ),
          body: signedOut
              ? ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                  children: [
                    SizedBox(
                      height: 280,
                      child: EmptyState(
                        icon: Icons.account_circle_outlined,
                        title: L('电脑上没登录账号', 'Not signed in on the computer'),
                        body: L(
                          '在电脑的设置 › 账号里登录像素星空账号后，这里就能看余额、充值。',
                          'Sign in under Settings › Account on the computer to see your balance and top up here.',
                        ),
                      ),
                    ),
                    // 没登录平台账号也能看订阅额度（§17）
                    QuotaSection(deviceId: widget.deviceId),
                  ],
                )
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                  children: [
                    _BalanceCard(account: account),
                    QuotaSection(deviceId: widget.deviceId, account: raw),
                    for (final o in _pending)
                      Padding(
                        padding: const EdgeInsets.only(top: 12),
                        child: Material(
                          color: c.bgSubtle,
                          borderRadius: BorderRadius.circular(Radii.card),
                          child: ListTile(
                            leading: Icon(Icons.schedule, color: c.warn),
                            title: Text(
                              L('有一笔待付款的订单', 'You have an unpaid order'),
                            ),
                            subtitle: Text(
                              '${o.planName ?? L('充值', 'Top-up')} · ${money(o.payAmount, o.payCurrency)} · ${o.methodLabel}',
                            ),
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () async {
                              try {
                                final full = await _checkout.get(o.id);
                                if (mounted) await _openOrder(full);
                              } catch (e) {
                                if (context.mounted) {
                                  showErrorSnack(
                                    context,
                                    checkoutError(actionError(e)),
                                  );
                                }
                              }
                            },
                          ),
                        ),
                      ),
                    const SizedBox(height: 16),
                    if (_storeError != null)
                      Text(
                        _storeError!,
                        style: TextStyle(fontSize: Fs.ui, color: c.danger),
                      )
                    else if (store == null)
                      const Padding(
                        padding: EdgeInsets.all(32),
                        child: Center(
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                      )
                    else if (store.methods.isEmpty)
                      Text(
                        L(
                          '现在不能在软件里付款，在电脑上打开购买页。',
                          'In-app payment is unavailable; use the store page on the computer.',
                        ),
                        style: TextStyle(fontSize: Fs.ui, color: c.textMuted),
                      )
                    else
                      ..._shop(store),
                  ],
                ),
        );
      },
    );
  }

  List<Widget> _shop(Store store) {
    final c = context.colors;
    final r = store.recharge;
    final choice = _choice(store);
    final canAct = _checkout.canAct;
    final methodLabel = store.methods
        .where((m) => m.type == _method)
        .map((m) => m.label)
        .firstOrNull;
    final typed = _custom.text.trim();
    final check = typed.isEmpty ? null : checkAmount(typed, r);
    return [
      SegmentedButton<bool>(
        segments: [
          if (r.enabled)
            ButtonSegment(value: false, label: Text(L('充值', 'Top up'))),
          if (store.plans.isNotEmpty)
            ButtonSegment(value: true, label: Text(L('订阅套餐', 'Plans'))),
        ],
        selected: {_plans || !r.enabled},
        onSelectionChanged: (v) => setState(() => _plans = v.first),
      ),
      const SizedBox(height: 12),
      if (!_plans && r.enabled) ...[
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final a in quickAmounts(r))
              ChoiceChip(
                label: Text(
                  [
                    money(a, store.currency),
                    if (matchTier(r.tiers, a) case final t?)
                      L('送 ${t.bonusPercent}%', '+${t.bonusPercent}%'),
                  ].join(' · '),
                ),
                selected: typed.isEmpty && _amount == a,
                onSelected: (_) => setState(() {
                  _amount = a;
                  _custom.clear();
                }),
              ),
          ],
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _custom,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            isDense: true,
            labelText: L('自定义金额', 'Custom amount'),
            helperText: r.max > 0
                ? L(
                    '${money(r.min, store.currency)}–${money(r.max, store.currency)}',
                    '${money(r.min, store.currency)}–${money(r.max, store.currency)}',
                  )
                : null,
            errorText: switch (check?.reason) {
              'format' => L('最多两位小数', 'Up to two decimals'),
              'min' => L(
                '最少 ${money(r.min, store.currency)}',
                'At least ${money(r.min, store.currency)}',
              ),
              'max' => L(
                '最多 ${money(r.max, store.currency)}',
                'At most ${money(r.max, store.currency)}',
              ),
              _ => null,
            },
            border: const OutlineInputBorder(),
          ),
        ),
        if (choice?.amount case final amount?) ...[
          const SizedBox(height: 8),
          Builder(
            builder: (_) {
              final q = quoteRecharge(r, amount);
              return Text(
                L(
                  '到账 \$${q.credited.toStringAsFixed(2)}${q.bonus > 0 ? '（含赠送 \$${q.bonus.toStringAsFixed(2)}）' : ''} · 应付 ${money(q.pay, store.currency)}',
                  'You get \$${q.credited.toStringAsFixed(2)}${q.bonus > 0 ? ' (incl. \$${q.bonus.toStringAsFixed(2)} bonus)' : ''} · Pay ${money(q.pay, store.currency)}',
                ),
                style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
              );
            },
          ),
        ],
      ],
      if (_plans)
        for (final p in store.plans)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Material(
              color: _planId == p.id ? c.accentSoft : c.bgSubtle,
              borderRadius: BorderRadius.circular(Radii.card),
              child: InkWell(
                borderRadius: BorderRadius.circular(Radii.card),
                onTap: () => setState(() => _planId = p.id),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              p.name,
                              style: TextStyle(
                                fontSize: Fs.prose,
                                fontWeight: FontWeight.w600,
                                color: c.text,
                              ),
                            ),
                          ),
                          Text(
                            money(p.price, store.currency),
                            style: TextStyle(
                              fontSize: Fs.prose,
                              fontWeight: FontWeight.w600,
                              color: c.text,
                            ),
                          ),
                        ],
                      ),
                      Text(
                        [
                          L('${p.validityDays} 天', '${p.validityDays} days'),
                          if (p.description.isNotEmpty) p.description,
                        ].join(' · '),
                        style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                      ),
                      for (final f in p.features)
                        Text(
                          '· $f',
                          style: TextStyle(
                            fontSize: Fs.meta,
                            color: c.textSecondary,
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
      const SizedBox(height: 12),
      Wrap(
        spacing: 8,
        children: [
          for (final m in store.methods)
            ChoiceChip(
              label: Text(m.label),
              selected: _method == m.type,
              onSelected: (_) => setState(() => _method = m.type),
            ),
        ],
      ),
      const SizedBox(height: 16),
      PrimaryButton(
        label: choice == null || methodLabel == null
            ? (_plans || !r.enabled
                  ? L('选好套餐和支付方式', 'Choose a plan and method')
                  : L('选好金额和支付方式', 'Choose an amount and method'))
            : L(
                '用$methodLabel付 ${money(choice.pay, store.currency)}',
                'Pay ${money(choice.pay, store.currency)} with $methodLabel',
              ),
        busy: _busy,
        onPressed: canAct && choice != null && methodLabel != null
            ? () => _pay(store)
            : null,
      ),
      if (!canAct)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(
            L(
              '这部手机是「只看」，能看余额，不能下单',
              'This phone is “View only” — you can see the balance but not pay',
            ),
            style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
          ),
        ),
      if (store.helpText.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Text(
            store.helpText,
            style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
          ),
        ),
    ];
  }
}

Future<void> _launch(String url) async {
  final uri = Uri.tryParse(url);
  if (uri == null || uri.scheme != 'https') return;
  await launchUrl(uri, mode: LaunchMode.externalApplication);
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.account});
  final Account? account;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final a = account;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: c.bgSubtle,
        borderRadius: BorderRadius.circular(Radii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            a?.name ?? '',
            style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
          ),
          const SizedBox(height: 4),
          Text(
            a == null ? '…' : formatBalance(a.balance, a.currency),
            style: TextStyle(
              fontSize: Fs.title,
              fontWeight: FontWeight.w600,
              color: c.text,
            ),
          ),
          if (a?.plan != null)
            Text(
              L('套餐：${a!.plan}', 'Plan: ${a.plan}'),
              style: TextStyle(fontSize: Fs.meta, color: c.textSecondary),
            ),
        ],
      ),
    );
  }
}

/// 付款状态：等待付款（倒计时、重新打开、存付款码）→ 正在到账 → 已到账；过期 / 取消 / 失败
class OrderScreen extends StatefulWidget {
  const OrderScreen({super.key, required this.checkout, required this.order});
  final Checkout checkout;
  final Order order;

  @override
  State<OrderScreen> createState() => _OrderScreenState();
}

class _OrderScreenState extends State<OrderScreen> with WidgetsBindingObserver {
  late Order _order = widget.order;
  Timer? _poll;
  Timer? _tick;
  bool _busy = false;
  final _qrKey = GlobalKey();

  /// 本机时钟和电脑（云端）时钟的差：倒计时按云端时间算
  late final Duration _skew = (widget.order.serverTime ?? DateTime.now())
      .difference(DateTime.now());

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _poll = Timer.periodic(const Duration(seconds: 3), (_) => _refresh());
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _order.pending) setState(() {});
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _tick?.cancel();
    super.dispose();
  }

  /// 从支付宝 / 微信回来：马上查一次
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh({bool verify = false}) async {
    if (_order.over && !verify) {
      _poll?.cancel();
      return;
    }
    try {
      final next = verify
          ? await widget.checkout.verify(_order.id)
          : await widget.checkout.get(_order.id);
      if (mounted) setState(() => _order = next);
    } catch (_) {
      // 下次再查
    }
  }

  void _toast(String text) =>
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(text)));

  Future<void> _cancel() async {
    setState(() => _busy = true);
    try {
      final next = await widget.checkout.cancel(_order.id);
      if (mounted) setState(() => _order = next);
    } catch (e) {
      if (mounted) showErrorSnack(context, checkoutError(actionError(e)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _saveQr() async {
    try {
      final boundary =
          _qrKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
      final image = await boundary?.toImage(pixelRatio: 3);
      final data = await image?.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) return;
      if (!await Gal.hasPermission() && !await Gal.requestPermission()) {
        if (mounted) _toast(L('没有存相册的权限', 'No permission to save photos'));
        return;
      }
      await Gal.putImageBytes(
        data.buffer.asUint8List(),
        name: 'pixelsky-pay-${_order.id}',
      );
      if (mounted) {
        _toast(
          L(
            '已存到相册：打开${_order.methodLabel}扫一扫 → 相册 → 选这张图',
            'Saved. In ${_order.methodLabel}: Scan → Album → pick this image',
          ),
        );
      }
    } catch (e) {
      if (mounted) _toast(L('没存成：$e', "Couldn't save: $e"));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final o = _order;
    final left = o.expiresAt?.difference(DateTime.now().add(_skew));
    final what =
        '${o.planName ?? L('充值', 'Top-up')} · ${money(o.payAmount, o.payCurrency)} · ${o.methodLabel}';
    final (icon, color, title) = switch (o.status) {
      'pending' => (Icons.schedule, c.warn, L('等待付款', 'Waiting for payment')),
      'paid' => (
        Icons.hourglass_top,
        c.accent,
        L('已付款，正在到账', 'Paid — crediting'),
      ),
      'completed' => (Icons.check_circle, c.success, L('已到账', 'Credited')),
      'expired' => (Icons.timer_off, c.textMuted, L('已过期', 'Expired')),
      'cancelled' => (Icons.cancel, c.textMuted, L('已取消', 'Cancelled')),
      'refunding' ||
      'refunded' => (Icons.undo, c.textMuted, L('已退款', 'Refunded')),
      _ => (Icons.error_outline, c.danger, L('付款失败', 'Payment failed')),
    };
    final qr = o.pending && o.openUrl == null ? o.qrContent : null;
    return AppScreen(
      title: L('付款', 'Payment'),
      leading: RoundIconButton(
        icon: Icons.arrow_back,
        tooltip: L('返回', 'Back'),
        onPressed: () => Navigator.of(context).pop(),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          Icon(icon, size: 48, color: color),
          const SizedBox(height: 8),
          Text(
            title,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: Fs.section,
              fontWeight: FontWeight.w600,
              color: c.text,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            what,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: Fs.ui, color: c.textMuted),
          ),
          if (o.done && o.credited != null)
            Text(
              L(
                '到账 \$${o.credited!.toStringAsFixed(2)}',
                'Credited \$${o.credited!.toStringAsFixed(2)}',
              ),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: Fs.ui, color: c.success),
            ),
          if (o.pending && left != null && !left.isNegative)
            Text(
              L(
                '还剩 ${left.inMinutes}:${(left.inSeconds % 60).toString().padLeft(2, '0')}',
                '${left.inMinutes}:${(left.inSeconds % 60).toString().padLeft(2, '0')} left',
              ),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
            ),
          const SizedBox(height: 20),
          if (qr != null) ...[
            Center(
              child: RepaintBoundary(
                key: _qrKey,
                child: Container(
                  color: Colors.white,
                  padding: const EdgeInsets.all(12),
                  child: QrImageView(data: qr, size: 220),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Text(
              L(
                '只给了付款码：存到相册后，打开${_order.methodLabel}扫一扫 → 相册 → 选这张图',
                'Only a QR code was given: save it, then in ${_order.methodLabel} tap Scan → Album → pick it',
              ),
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
            ),
            const SizedBox(height: 8),
            PrimaryButton(
              label: L('存到相册', 'Save to photos'),
              icon: Icons.download,
              onPressed: _saveQr,
            ),
            const SizedBox(height: 8),
          ],
          if (o.pending && o.openUrl != null) ...[
            PrimaryButton(
              label: L('打开${o.methodLabel}付款', 'Open ${o.methodLabel}'),
              icon: Icons.open_in_new,
              onPressed: () => _launch(o.openUrl!),
            ),
            const SizedBox(height: 8),
          ],
          if (o.pending) ...[
            SecondaryButton(
              label: L('我已付款', "I've paid"),
              onPressed: _busy ? null : () => _refresh(verify: true),
            ),
            const SizedBox(height: 8),
            SecondaryButton(
              label: L('取消订单', 'Cancel order'),
              onPressed: _busy || !widget.checkout.canAct ? null : _cancel,
            ),
          ],
          if (o.over)
            SecondaryButton(
              label: o.done ? L('完成', 'Done') : L('重新下单', 'Order again'),
              onPressed: () => Navigator.of(context).pop(),
            ),
        ],
      ),
    );
  }
}
