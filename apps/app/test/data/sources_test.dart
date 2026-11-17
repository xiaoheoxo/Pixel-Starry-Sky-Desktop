// B4：额度来源的规则（docs/mobile-app.md §14.4）
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/data/sources.dart';
import 'package:pixelsky_app/i18n/i18n.dart';

void main() {
  setUp(() => language.value = AppLanguage.zh);
  final sources = PhoneSources({
    'platform': [
      {
        'id': '34',
        'name': '便宜',
        'rate': 0.6,
        'models': ['a', 'b'],
      },
      {
        'id': '35',
        'name': '贵',
        'rate': 1.5,
        'models': ['a'],
      },
    ],
    'platformError': null,
    'providers': [
      {
        'id': 'p1',
        'name': '中转',
        'models': ['m1'],
      },
      {'id': 'p2', 'name': '空', 'models': <String>[]},
    ],
  });

  test('会话现在用的来源', () {
    expect(sourceKey({}), 'self');
    expect(
      sourceKey({
        'platform': {'groupId': '34', 'account': 'x'},
      }),
      'platform:34',
    );
    expect(
      sourceKey({
        'provider': {'id': 'p1'},
      }),
      'provider:p1',
    );
  });

  test('倍率最多三位小数', () {
    expect([1.0, 0.6, 1.5, 0.125, 10.0].map(rateText), [
      '×1',
      '×0.6',
      '×1.5',
      '×0.125',
      '×10',
    ]);
  });

  test('选项：自己的账号、各条线路带倍率、各个接口；现在用的已经不在列表里时灰着列出来', () {
    final options = sourceOptions(sources, {});
    expect(options.map((o) => o.value), [
      'self',
      'platform:34',
      'platform:35',
      'provider:p1',
      'provider:p2',
    ]);
    expect(options[1].hint, '倍率 ×0.6');
    final gone = sourceOptions(sources, {
      'provider': {'id': 'old'},
    });
    expect(gone.last.value, 'provider:old');
    expect(gone.last.disabled, isTrue);
  });

  test('补丁', () {
    expect(sourcePatch('self'), {
      'source': {'kind': 'self'},
    });
    expect(sourcePatch('platform:34'), {
      'source': {'kind': 'platform', 'groupId': '34'},
    });
    expect(sourcePatch('provider:p1'), {
      'source': {'kind': 'provider', 'id': 'p1'},
    });
  });

  test('换到平台要确认；平台里换成更便宜的或一样的不用，换成更贵的要', () {
    expect(sourceConfirm(sources, {}, 'platform:34'), contains('×0.6'));
    expect(sourceConfirm(sources, {}, 'provider:p1'), isNull);
    expect(sourceConfirm(sources, {}, 'self'), isNull);
    final onCheap = {
      'platform': {'groupId': '34'},
    };
    final onDear = {
      'platform': {'groupId': '35'},
    };
    expect(sourceConfirm(sources, onCheap, 'platform:35'), contains('×1.5'));
    expect(sourceConfirm(sources, onDear, 'platform:34'), isNull);
  });

  test('平台 / 接口会话的模型来自那条线路 / 接口；接口没列模型、自己的账号为 null', () {
    expect(
      sourceModels(sources, {
        'platform': {'groupId': '34'},
      }),
      ['a', 'b'],
    );
    expect(
      sourceModels(sources, {
        'provider': {'id': 'p1'},
      }),
      ['m1'],
    );
    expect(
      sourceModels(sources, {
        'provider': {'id': 'p2'},
      }),
      isNull,
    );
    expect(sourceModels(sources, {}), isNull);
    expect(
      sourceModels(null, {
        'platform': {'groupId': '34'},
      }),
      isNull,
    );
  });

  test('电脑没登录平台：platform 为 null，带原因', () {
    final out = PhoneSources({
      'platform': null,
      'platformError': '没有登录像素星空账号',
      'providers': <Object>[],
    });
    expect(out.platform, isNull);
    expect(out.platformError, '没有登录像素星空账号');
    expect(sourceOptions(out, {}).map((o) => o.value), ['self']);
  });
}
