import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/link/link.dart';

import 'fixtures.dart';

String message(Object e) => e is LinkException ? e.message : '$e';

void main() {
  final f = fixture('link_rpc.json');

  test('constants match TS', () async {
    final c = f['constants'] as Map<String, dynamic>;
    expect(rpcSizeLimit, c['size_limit']);
    final closed = RpcCore((_) {})..close();
    await expectLater(closed.call('x'), throwsLink(c['closed_error']));
    final slow = RpcCore((_) {});
    await expectLater(
      slow.call('x', [], const Duration(milliseconds: 1)),
      throwsLink(c['timeout_error']),
    );
  });

  test('sends calls and events with the same JSON as TS', () {
    final sent = <RpcMessage>[];
    final core = RpcCore(sent.add);
    for (final o in cases(f, 'outgoing')) {
      if (o.containsKey('call')) {
        core.call(o['call'], o['args']).ignore();
      } else {
        core.event(o['event'], o['data']);
      }
      // 比 JSON 文本：键的顺序也要一样
      expect(jsonEncode(sent.last), jsonEncode(o['message']));
    }
    core.close();
  });

  test('replies to calls with the same JSON as TS', () async {
    final limit = (f['constants'] as Map)['reply_limit'] as int;
    for (final c in cases(f, 'handled')) {
      final h = c['handler'] as Map<String, dynamic>;
      final replies = <RpcMessage>[];
      final core = RpcCore(
        (m) {
          if (jsonEncode(m).length > limit) {
            throw const LinkException(rpcSizeLimit);
          }
          replies.add(m);
        },
        handler: (method, args) {
          if (h.containsKey('throw')) throw LinkException(h['throw']);
          return h['result'];
        },
      );
      core.receive(c['request']);
      await settle();
      expect(
        replies.map(jsonEncode),
        (c['replies'] as List).map(jsonEncode),
        reason: jsonEncode(c['request']),
      );
    }
  });

  test('handles incoming messages like TS', () async {
    for (final c in cases(f, 'incoming')) {
      final replies = <Object?>[], events = <Object?>[];
      Object? call = 'pending';
      String? closed;
      final core = RpcCore((m) => replies.add(jsonDecode(jsonEncode(m))));
      core
          .call('x', [], const Duration(seconds: 60))
          .then(
            (v) => call = {'resolved': v},
            onError: (Object e) => call = {'rejected': message(e)},
          );
      replies.clear();
      core.onEvent = (channel, data) => events.add([channel, data]);
      core.onClose = (e) => closed = message(e);
      core.receive(c['raw']);
      await settle();
      final name = c['name'];
      expect(call, c['call'], reason: name);
      expect(closed, c['closed'], reason: name);
      expect(events, c['events'], reason: name);
      expect(replies, c['replies'], reason: name);
      core.close();
    }
  });

  group('Dart RpcCore', () {
    ({RpcCore a, RpcCore b}) pair() {
      late RpcCore a, b;
      a = RpcCore(
        (m) => scheduleMicrotask(() => b.receive(jsonDecode(jsonEncode(m)))),
        handler: (method, args) => {
          'from': 'a',
          'method': method,
          'args': args,
        },
      );
      b = RpcCore(
        (m) => scheduleMicrotask(() => a.receive(m)),
        handler: (method, args) async {
          if (method == 'fail') throw const LinkException('EXPECTED');
          if (method == 'never') return Completer<Object?>().future;
          if (method == 'back') return b.call('nested', args);
          return args;
        },
      );
      return (a: a, b: b);
    }

    test('answers calls, nested calls and errors', () async {
      final p = pair();
      expect(await p.a.call('echo', [1, '中文']), [1, '中文']);
      expect(await p.a.call('back', ['x']), {
        'from': 'a',
        'method': 'nested',
        'args': ['x'],
      });
      await expectLater(p.a.call('fail'), throwsLink('EXPECTED'));
      await expectLater(
        p.a.call('never', [], const Duration(milliseconds: 10)),
        throwsLink('RPC_TIMEOUT: never'),
      );
    });

    test('a non-LinkException from the handler replies RPC_FAILED', () async {
      final replies = <RpcMessage>[];
      final core = RpcCore(
        replies.add,
        handler: (_, _) => throw StateError('internal detail'),
      );
      core.receive({'id': 1, 'method': 'x', 'args': []});
      await settle();
      expect(replies, [
        {'id': 1, 'error': 'RPC_FAILED'},
      ]);
    });

    test('delivers events and rejects pending calls on close', () async {
      final p = pair();
      final events = <Object?>[];
      p.b.onEvent = (channel, data) => events.add([channel, data]);
      p.a.event('engine:event', {'kind': 'sessions'});
      await settle();
      expect(events, [
        [
          'engine:event',
          {'kind': 'sessions'},
        ],
      ]);
      final pending = p.a.call('never');
      p.a.close();
      await expectLater(pending, throwsLink('LINK_CLOSED'));
      await expectLater(p.a.call('echo'), throwsLink('LINK_CLOSED'));
    });

    test('closes on a malformed message and when output throws', () async {
      Object? reason;
      final core = RpcCore((_) {}, closedMessage: 'GONE');
      core.onClose = (e) => reason = e;
      core.receive({'id': 'x'});
      expect(core.isClosed, isTrue);
      expect(message(reason!), 'Invalid RPC id');
      await expectLater(core.call('x'), throwsLink('GONE'));

      final sent = <RpcMessage>[];
      final full = RpcCore((m) {
        sent.add(m);
        throw const LinkException('TOO_BIG');
      });
      await expectLater(full.call('x'), throwsLink('TOO_BIG'));
      full.event('e', 1);
      expect(full.isClosed, isTrue);
      expect(sent, hasLength(2));
    });

    test(
      'an oversized call fails alone; an oversized event is dropped',
      () async {
        final sent = <RpcMessage>[];
        final core = RpcCore((m) {
          if (jsonEncode(m).length > 100) {
            throw const LinkException(rpcSizeLimit);
          }
          sent.add(m);
        });
        await expectLater(
          core.call('big', ['x' * 200]),
          throwsLink(rpcSizeLimit),
        );
        core.event('big', 'x' * 200);
        core.event('small', 1);
        expect(core.isClosed, isFalse);
        expect(sent.map((m) => m['event']), ['small']);
        core.close();
      },
    );

    test(
      'a reply that cannot be written for other reasons closes the link',
      () async {
        Object? closed;
        final broken = RpcCore(
          (_) => throw const LinkException('BROKEN'),
          handler: (_, _) => 1,
        );
        broken.onClose = (e) => closed = e;
        broken.receive({'id': 1, 'method': 'x', 'args': []});
        await settle();
        expect(message(closed!), 'BROKEN');
      },
    );
  });
}
