// E1：充值的报价、金额校验（数和电脑 storeLogic.test.ts 一样）、手机上怎么付、错误码换人话。
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/data/checkout.dart';
import 'package:pixelsky_app/i18n/i18n.dart';
import 'package:pixelsky_app/protocol/json.dart';

Recharge _r([Json over = const {}]) => Recharge({
  'enabled': true,
  'min': 5,
  'max': 500,
  'multiplier': 1.5,
  'feeRate': 2,
  'bonusMode': 'bonus',
  'bonusTiers': [
    {'minAmount': 100, 'bonusPercent': 5},
    {'minAmount': 500, 'bonusPercent': 10},
  ],
  ...over,
});

void main() {
  setUp(() => language.value = AppLanguage.zh);

  test('档位：不超过金额的最大一档', () {
    final tiers = _r().tiers;
    expect(matchTier(tiers, 99.99), isNull);
    expect(matchTier(tiers, 100)?.bonusPercent, 5);
    expect(matchTier(tiers, 499)?.bonusPercent, 5);
    expect(matchTier(tiers, 500)?.bonusPercent, 10);
  });

  test('报价（同电脑 quoteRecharge）', () {
    var q = quoteRecharge(_r(), 50);
    expect(
      (q.credited, q.bonus, q.payBase, q.fee, q.pay, q.percent),
      (75.0, 0.0, 50.0, 1.0, 51.0, 0),
    );
    q = quoteRecharge(_r(), 100);
    expect(
      (q.credited, q.bonus, q.fee, q.pay, q.percent),
      (157.5, 7.5, 2.0, 102.0, 5),
    );
    q = quoteRecharge(_r({'bonusMode': 'discount'}), 100);
    expect(
      (q.credited, q.bonus, q.payBase, q.fee, q.pay),
      (150.0, 7.5, 95.0, 1.9, 96.9),
    );
    expect(quoteRecharge(_r({'multiplier': 1}), 3.33).fee, 0.07);
    q = quoteRecharge(
      _r({
        'bonusMode': 'discount',
        'bonusTiers': [
          {'minAmount': 1, 'bonusPercent': 100},
        ],
      }),
      10,
    );
    expect((q.percent, q.payBase), (0, 10.0));
    expect(round2(1.005), 1.01);
    expect(round2(2.675), 2.68);
  });

  test('金额校验', () {
    final r = _r();
    expect(checkAmount('', r).reason, 'empty');
    expect(checkAmount('1.234', r).reason, 'format');
    expect(checkAmount('abc', r).reason, 'format');
    expect(checkAmount('4.99', r).reason, 'min');
    expect(checkAmount('500.01', r).reason, 'max');
    expect(checkAmount(' 88.8 ', r).value, 88.8);
    expect(checkAmount('9999', _r({'max': 0})).value, 9999);
  });

  test('怎么付：https 支付链接或收银台码直接打开；微信原生码只能扫', () {
    Order o(Json j) => Order({'status': 'pending', ...j});
    expect(
      o({'payUrl': 'https://pay.example.com/a'}).openUrl,
      'https://pay.example.com/a',
    );
    expect(
      o({'qrContent': 'https://cashier.example.com/x'}).openUrl,
      'https://cashier.example.com/x',
    );
    expect(o({'qrContent': 'weixin://wxpay/bizpayurl?pr=1'}).openUrl, isNull);
    expect(o({'payUrl': 'http://insecure'}).openUrl, isNull);
  });

  test('错误码换人话；金额范围带上下限', () {
    expect(
      checkoutError('MOBILE_CHECKOUT_AMOUNT_OUT_OF_RANGE:5:500'),
      '金额要在 5–500 之间',
    );
    expect(
      checkoutError('MOBILE_CHECKOUT_PANEL_REAUTH_REQUIRED'),
      contains('电脑上确认'),
    );
    expect(checkoutError('MOBILE_CHECKOUT_WHATEVER'), contains('出错'));
    expect(checkoutError('请先刷新套餐信息'), '请先刷新套餐信息');
  });
}
