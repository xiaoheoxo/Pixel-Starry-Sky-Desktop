// 充值（第三批 E1，docs/mobile-app.md §15.13）：手机不登录账号，借电脑的账号下单（网关的 store、checkout*）。
// 报价、金额校验照电脑 renderer/src/features/account/storeLogic.ts（公式照 Sub2api），两边的测试用同一组数。
// 付款：支付宝的码内容是收银台 https 链接，手机直接打开；微信只有原生付款码，给「保存到相册」。
import 'dart:async';

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../i18n/i18n.dart';
import '../protocol/json.dart';
import 'retry.dart';

num _num(Object? v) => v is num ? v : 0;

/// 先乘 100 再按 15 位有效数字消掉浮点误差（1.005 × 100 = 100.49999999999999 → 100.5）
double _cents(num v) => double.parse((v * 100).toStringAsPrecision(15));

/// 十进制四舍五入到分（半数远离零）
double round2(num v) {
  if (!v.isFinite || v.abs() >= 1e13) return v.toDouble();
  final r = _cents(v.abs()).round() / 100;
  return v < 0 && r != 0 ? -r : r;
}

/// 向上取整到分
double roundUp2(num v) {
  if (!v.isFinite || v.abs() >= 1e13) return v.toDouble();
  final r = (_cents(v) - 1e-9).ceil() / 100;
  return r == 0 ? 0 : r;
}

extension type BonusTier(Json json) implements Json {
  num get minAmount => _num(json['minAmount']);
  num get bonusPercent => _num(json['bonusPercent']);
}

/// 充值规则（apps/desktop 的 StoreRecharge）
extension type Recharge(Json json) implements Json {
  bool get enabled => json['enabled'] == true;
  num get min => _num(json['min']);
  num get max => _num(json['max']);
  num get multiplier =>
      json['multiplier'] is num ? json['multiplier'] as num : 1;
  num get feeRate => _num(json['feeRate']);
  bool get discount => json['bonusMode'] == 'discount';
  List<BonusTier> get tiers => [
    for (final t in objList(json['bonusTiers'])) BonusTier(t),
  ];
}

/// 套餐（apps/desktop 的 StorePlan）
extension type Plan(Json json) implements Json {
  int get id => (json['id'] as num?)?.toInt() ?? 0;
  String get name => str(json['name']) ?? '';
  String get description => str(json['description']) ?? '';
  num get price => _num(json['price']);
  num? get originalPrice => json['originalPrice'] as num?;
  int get validityDays => (json['validityDays'] as num?)?.toInt() ?? 0;
  List<String> get features => [
    for (final f in (json['features'] as List? ?? const []))
      if (f is String) f,
  ];
}

/// 商品（apps/desktop 的 StoreCatalog，不含面板页地址）
extension type Store(Json json) implements Json {
  String get currency => str(json['currency']) ?? 'CNY';
  Recharge get recharge => Recharge(obj(json['recharge']));
  List<Plan> get plans => [for (final p in objList(json['plans'])) Plan(p)];
  String get helpText => str(json['helpText']) ?? '';

  /// 软件内付款开着、能用的支付方式（alipay / wxpay），按商品里的顺序和名字
  List<({String type, String label})> get methods {
    final checkout = obj(json['checkout']);
    if (checkout['enabled'] != true || json['enabled'] != true) return const [];
    final allowed = {
      for (final m in (checkout['methods'] as List? ?? const []))
        if (m is String) m,
    };
    return [
      for (final m in objList(json['methods']))
        if (allowed.contains(str(m['type'])))
          (type: str(m['type'])!, label: str(m['label']) ?? str(m['type'])!),
    ];
  }
}

/// 命中的赠送 / 折扣档位：不超过支付金额的最大 minAmount
BonusTier? matchTier(List<BonusTier> tiers, num amount) {
  BonusTier? hit;
  for (final t in [
    ...tiers,
  ]..sort((a, b) => a.minAmount.compareTo(b.minAmount))) {
    if (amount + 1e-9 < t.minAmount) break;
    hit = t;
  }
  return hit != null && hit.bonusPercent > 0 ? hit : null;
}

typedef RechargeQuote = ({
  double credited,
  double bonus,
  double payBase,
  double fee,
  double pay,
  num percent,
});

/// 充值报价（同电脑 quoteRecharge）
RechargeQuote quoteRecharge(Recharge r, num amount) {
  final base = round2(amount * r.multiplier);
  var credited = base;
  var bonus = 0.0;
  var payBase = amount.toDouble();
  num percent = 0;
  final tier = matchTier(r.tiers, amount);
  if (tier != null) {
    if (r.discount) {
      if (tier.bonusPercent < 100) {
        final discounted = round2(amount * (100 - tier.bonusPercent) / 100);
        if (discounted > 0 && discounted < amount) {
          payBase = discounted;
          final b = round2(base - round2(discounted * r.multiplier));
          bonus = b > 0 ? b : 0;
          percent = tier.bonusPercent;
        }
      }
    } else {
      final extra = round2(base * tier.bonusPercent / 100);
      if (extra > 0) {
        bonus = extra;
        credited = round2(base + extra);
        percent = tier.bonusPercent;
      }
    }
  }
  final fee = r.feeRate > 0 ? roundUp2(payBase * r.feeRate / 100) : 0.0;
  return (
    credited: credited,
    bonus: bonus,
    payBase: payBase,
    fee: fee,
    pay: round2(payBase + fee),
    percent: percent,
  );
}

/// 校验输入的金额：最多两位小数，落在 [min, max]（max 为 0 不限）；不对时返回原因
({double? value, String? reason}) checkAmount(String input, Recharge r) {
  final s = input.trim();
  if (s.isEmpty) return (value: null, reason: 'empty');
  if (!RegExp(r'^\d+(\.\d{1,2})?$').hasMatch(s)) {
    return (value: null, reason: 'format');
  }
  final v = double.parse(s);
  if (!(v > 0)) return (value: null, reason: 'format');
  if (v < r.min) return (value: null, reason: 'min');
  if (r.max > 0 && v > r.max) return (value: null, reason: 'max');
  return (value: v, reason: null);
}

/// 一笔订单（网关的 phoneOrder）
extension type Order(Json json) implements Json {
  int get id => (json['orderId'] as num?)?.toInt() ?? 0;
  String get kind => str(json['kind']) ?? 'balance';

  /// pending / paid / completed / expired / cancelled / failed / refunding / refunded / unknown
  String get status => str(json['status']) ?? 'unknown';
  String get method => str(json['method']) ?? '';
  String get methodLabel => str(json['methodLabel']) ?? method;
  num get payAmount => _num(json['payAmount']);
  String get payCurrency => str(json['payCurrency']) ?? 'CNY';
  num? get credited => json['credited'] as num?;
  String? get planName => str(obj(json['plan'])['name']);
  String? get payUrl => str(json['payUrl']);
  String? get qrContent => str(json['qrContent']);
  DateTime? get expiresAt => DateTime.tryParse(str(json['expiresAt']) ?? '');
  DateTime? get serverTime => DateTime.tryParse(str(json['serverTime']) ?? '');

  bool get pending => status == 'pending';
  bool get done => status == 'completed';
  bool get paid => status == 'paid';
  bool get over => !pending && !paid;

  /// 手机上能直接打开的付款页：支付链接，或码内容本身就是 https 收银台（支付宝）；没有时 null（只能扫码）
  String? get openUrl {
    for (final u in [payUrl, qrContent]) {
      if (u != null && Uri.tryParse(u)?.scheme == 'https') return u;
    }
    return null;
  }
}

/// 电脑回的错误码 → 人话（网关的 MOBILE_CHECKOUT_*）；别的原样
String checkoutError(Object e) {
  final code = '$e'.replaceFirst(RegExp(r'^Exception: '), '');
  if (!code.startsWith('MOBILE_CHECKOUT_')) return code;
  final parts = code.substring('MOBILE_CHECKOUT_'.length).split(':');
  return switch (parts.first) {
    'PANEL_REAUTH_REQUIRED' => L(
      '请在电脑上确认一次账号（已在电脑上打开确认页），确认完再点付款',
      'Confirm your account on the computer (a page just opened there), then tap pay again',
    ),
    'PAYMENT_DISABLED' => L('现在不能在线付款', 'Online payment is unavailable'),
    'METHOD_UNAVAILABLE' => L('这种支付方式暂时不能用', 'This method is unavailable'),
    'AMOUNT_OUT_OF_RANGE' when parts.length == 3 => L(
      '金额要在 ${parts[1]}–${parts[2]} 之间',
      'Amount must be between ${parts[1]} and ${parts[2]}',
    ),
    'AMOUNT_OUT_OF_RANGE' => L('金额不在允许的范围内', 'Amount out of range'),
    'PLAN_UNAVAILABLE' => L('这个套餐已经下架了', 'This plan is no longer available'),
    'TOO_MANY_PENDING' => L(
      '待付款的订单太多，先付掉或取消几笔',
      'Too many unpaid orders — pay or cancel some first',
    ),
    'DAILY_LIMIT_EXCEEDED' => L('今天的充值额度用完了', 'Daily limit reached'),
    'RATE_LIMITED' || 'CANCEL_RATE_LIMITED' => L(
      '操作太频繁，稍后再试',
      'Too many requests — try again later',
    ),
    'ORDER_NOT_CANCELLABLE' => L(
      '这笔订单已经不能取消了',
      'This order can no longer be cancelled',
    ),
    _ => L('付款服务出错了，稍后再试', 'Payment service error — try again later'),
  };
}

/// 一台电脑的充值：商品、下单、查单
class Checkout {
  Checkout(this._connections, this.deviceId);
  final Connections _connections;
  final String deviceId;

  DesktopLink? get link => _connections.link(deviceId);

  bool get canAct =>
      link?.state == LinkState.ready && link?.hello?.access == 'act';

  Future<Object?> _call(String method, [List<Object?> args = const []]) {
    final l = link;
    if (l == null) return Future.error(const LinkNotReady());
    // 下单要等支付商建单，电脑那边给了 40 秒
    return l.call(method, args, const Duration(seconds: 50));
  }

  Future<Store> store() async => Store(obj(await _call('store')));

  /// requestId：一次「下单意图」一个，重试、确认账号后再下都用同一个（云端不会重复下单）
  Future<Order> create({
    required String requestId,
    required String method,
    double? amount,
    int? planId,
  }) async => Order(
    obj(
      await _call('checkoutCreate', [
        {
          'requestId': requestId,
          'kind': planId == null ? 'balance' : 'plan',
          'amount': ?amount,
          'planId': ?planId,
          'method': method,
        },
      ]),
    ),
  );

  Future<Order> get(int id) async =>
      Order(obj(await _call('checkoutGet', [id])));
  Future<Order> verify(int id) async =>
      Order(obj(await _call('checkoutVerify', [id])));
  Future<Order> cancel(int id) async =>
      Order(obj(await _call('checkoutCancel', [id])));
  Future<List<Order>> pending() async => [
    for (final o in objList(await _call('checkoutPending'))) Order(o),
  ];

  /// 电脑上打开浏览器确认账号
  Future<void> panelVerify() => _call('panelVerify').then((_) {});

  static String newRequestId() => uuid();
}
