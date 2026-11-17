// 演示模式（flutter run --dart-define=DEMO=1，docs/mobile-app.md §11）：不连真电脑，
// App 里起一台「假电脑」，走真的握手、加密通道和 RPC。每个会话存一份快照，推给手机的事件先用同一个 reduce 折进去，
// 所以重新打开看到的和推送的一致。能发消息（跑一段写好的回合）、排队、审批 / 提问、停止、改模式、改名、置顶、归档、新建。
// 只用来看界面、截图；正式包里 DEMO 是 false，这个文件不会被用到。
import 'dart:async';
import 'dart:typed_data';

import '../connection/pairing.dart';
import '../connection/socket.dart';
import '../link/link.dart';
import '../protocol/json.dart';
import '../protocol/reduce.dart';
import 'demo_feedback.dart';
import 'demo_tools.dart';

// bool.fromEnvironment 只认 true，文档里写的是 DEMO=1，两种都认
const demoEnabled =
    String.fromEnvironment('DEMO') == '1' || bool.fromEnvironment('DEMO');

class _DemoSocket implements RelaySocket {
  _DemoSocket(this._desktop);
  final DemoDesktop _desktop;
  void Function(Object message)? _onMessage;
  bool closed = false;

  @override
  void listen(
    void Function(Object message) onMessage, {
    required void Function(int? code) onDone,
  }) {
    _onMessage = onMessage;
  }

  @override
  void send(Object data) {
    if (!closed) _desktop._fromPhone(this, data as Uint8List);
  }

  @override
  void close() => closed = true;

  void deliver(Object message) => scheduleMicrotask(() {
    if (!closed) _onMessage?.call(message);
  });
}

class DemoDesktop {
  DemoDesktop() {
    _seed();
  }

  final Keypair key = generateKeypair();
  final Keypair phone = generateKeypair();
  _DemoSocket? _socket;
  RpcCore? _rpc;
  SecureChannel? _channelOf;

  /// 配好的手机：App 启动时直接用它
  Pairing get pairing => Pairing(
    deviceId: 'demo-phone',
    token: 'demo',
    desktopId: 'demo-desktop',
    desktopName: L10n.desktop,
    origin: 'https://demo.invalid',
    desktopKey: toBase64Url(key.publicKey),
    fingerprint: fingerprint(key.publicKey),
    phoneKey: toBase64Url(phone.privateKey),
    pairedAt: 0,
    status: PairingStatus.paired,
  );

  Future<RelaySocket> accept(Uri url, List<String> protocols) async {
    final s = _DemoSocket(this);
    _socket = s;
    Timer.run(() => s.deliver('{"type":"desktop_online"}'));
    return s;
  }

  void _fromPhone(_DemoSocket s, Uint8List frame) {
    final f = decodeFrame(frame);
    if (f.type == FrameType.handshake1) {
      final r = Responder(
        local: key,
        remote: phone.publicKey,
        prologue: prologue,
      );
      r.readMessage1(f.body);
      final out = r.writeMessage2();
      s.deliver(encodeFrame(FrameType.handshake2, out.message));
      late final SecureChannel channel;
      final rpc = RpcCore(
        (m) => channel.send(m).catchError((Object _) {}),
        handler: _handle,
      );
      channel = SecureChannel(
        out.result,
        output: s.deliver,
        onMessage: rpc.receive,
        onError: (_) {},
        codec: deflateRawCodec,
      );
      _rpc = rpc;
      _channelOf = channel;
    } else if (f.type == FrameType.data) {
      _channelOf?.receive(f.body);
    }
  }

  // -------------------------------------------------------------------------
  // 会话：每个一份快照
  // -------------------------------------------------------------------------

  late final List<Json> _projects;
  final _snaps = <String, Json>{};
  final _seq = <String, int>{};
  final _timers = <String, List<Timer>>{};
  int _ids = 0;
  String _id(String p) => '$p${++_ids}';
  int get _now => DateTime.now().millisecondsSinceEpoch;

  Json _record(String id) => obj(_snaps[id]!['record']);

  List<Json> _summaries() => [
    for (final e in _snaps.entries)
      {'record': e.value['record'], 'state': e.value['state']},
  ];

  /// 推一个会话事件：先折进自己的快照，再发给手机
  void _push(String id, Json event) {
    final seq = (_seq[id] ?? 0) + 1;
    _seq[id] = seq;
    final before = _snaps[id]!;
    _snaps[id] = reduce(before, event);
    _rpc?.event('engine:event', {
      'kind': 'session',
      'sessionId': id,
      'seq': seq,
      'event': event,
    });
    final t = event['type'];
    if (t == 'status' || t == 'record') _pushList();
  }

  void _pushList() => _rpc?.event('engine:event', {
    'kind': 'sessions',
    'sessions': _summaries(),
  });

  void _setRecord(String id, Json patch) => _push(id, {
    'type': 'record',
    'record': {..._record(id), ...patch, 'updatedAt': _now},
  });

  void _status(String id, String state) =>
      _push(id, {'type': 'status', 'state': state});

  void _queue(String id, List<Json> items, {bool? paused}) => _push(id, {
    'type': 'queue',
    'items': items,
    'paused': paused ?? _snaps[id]!['queuePaused'] == true,
  });

  List<Json> _queueOf(String id) => objList(_snaps[id]!['queue']);

  /// 按顺序隔一段时间做一件事；停止时一起取消
  void _later(String id, List<(int, void Function())> steps) {
    var at = 0;
    for (final (ms, run) in steps) {
      at += ms;
      final timer = Timer(Duration(milliseconds: at), () {
        if (_snaps.containsKey(id)) run();
      });
      (_timers[id] ??= []).add(timer);
    }
  }

  void _cancel(String id) {
    for (final t in _timers.remove(id) ?? const <Timer>[]) {
      t.cancel();
    }
    if (id == 's1') _stream?.cancel();
  }

  /// 跑一轮：你的消息 → 思考 → 一条命令 → 一段回复 → 统计；跑完接着发队列里的下一条
  void _turn(
    String id,
    String text, {
    List<Object?>? attachments,
    String mode = 'normal',
  }) {
    final turnId = _id('t');
    final reasoning = _id('r'), command = _id('c'), reply = _id('a');
    final start = _now;
    _push(id, {
      'type': 'item_started',
      'item': {
        'kind': 'user',
        'id': _id('u'),
        'text': text,
        'createdAt': start,
        'mode': mode,
        if (attachments != null && attachments.isNotEmpty)
          'attachments': [
            for (final a in attachments) {...obj(a), 'dataBase64': ''},
          ],
      },
    });
    _push(id, {'type': 'turn_started', 'turnId': turnId, 'execution': null});
    // 同电脑：发了消息的会话排到最前（列表按 updatedAt）
    _setRecord(id, {});
    _status(id, 'running');
    final words = L10n.replyWords;
    _later(id, [
      (
        700,
        () => _push(id, {
          'type': 'item_started',
          'item': {
            'kind': 'reasoning',
            'id': reasoning,
            'text': L10n.think2,
            'status': 'running',
          },
        }),
      ),
      (
        1200,
        () => _push(id, {
          'type': 'item_completed',
          'item': {
            'kind': 'reasoning',
            'id': reasoning,
            'text': L10n.think2,
            'status': 'completed',
            'durationMs': 1200,
          },
        }),
      ),
      (
        300,
        () => _push(id, {
          'type': 'item_started',
          'item': _cmd(command, 'running'),
        }),
      ),
      // 消息里带 approve：跑命令前要你允许（演示「等你处理」的提醒和审批）
      if (text.toLowerCase().contains('approve'))
        (
          100,
          () {
            _cancel(id);
            _waitingCommand[id] = (
              command: command,
              turnId: turnId,
              start: start,
            );
            _push(id, {
              'type': 'approval_request',
              'request': {
                'requestId': _id('req'),
                'itemId': command,
                'kind': 'command',
                'title': '运行命令',
                'command': 'flutter test',
                'alwaysScopes': ['project'],
              },
            });
            _status(id, 'waiting');
          },
        ),
      (
        2200,
        () => _push(id, {
          'type': 'item_completed',
          'item': _cmd(command, 'completed'),
        }),
      ),
      (
        300,
        () => _push(id, {
          'type': 'item_started',
          'item': {
            'kind': 'assistant',
            'id': reply,
            'text': '',
            'status': 'running',
          },
        }),
      ),
      for (final w in words)
        (
          180,
          () => _push(id, {
            'type': 'item_delta',
            'itemId': reply,
            'field': 'text',
            'delta': w,
          }),
        ),
      (
        300,
        () {
          final now = _now;
          _push(id, {
            'type': 'item_completed',
            'item': {
              'kind': 'assistant',
              'id': reply,
              'text': words.join(),
              'status': 'completed',
            },
          });
          _push(id, {
            'type': 'item_completed',
            'item': {
              'kind': 'turn_stats',
              'id': _id('st'),
              'turnId': turnId,
              'outcome': 'completed',
              'usage': _usage(now - start, 18400, 920),
            },
          });
          _push(id, {
            'type': 'turn_completed',
            'turnId': turnId,
            'outcome': 'completed',
          });
          _status(id, 'idle');
          _setRecord(id, {
            'lastOutcome': 'completed',
            'lastReply': words.join(),
          });
          _next(id);
        },
      ),
    ]);
  }

  /// 队列里还有：发下一条
  void _next(String id) {
    final q = _queueOf(id);
    if (q.isEmpty || _snaps[id]!['queuePaused'] == true) return;
    final first = q.first;
    _queue(id, q.sublist(1));
    _turn(
      id,
      str(first['text']) ?? '',
      attachments: first['attachments'] as List?,
    );
  }

  void _stop(String id) {
    _cancel(id);
    final turnId = _snaps[id]!['turnId'];
    if (turnId != null) {
      _push(id, {
        'type': 'turn_completed',
        'turnId': turnId,
        'outcome': 'interrupted',
      });
    }
    _status(id, 'idle');
  }

  Json _cmd(String id, String status) => {
    'kind': 'command',
    'id': id,
    'command': 'flutter test',
    'description': '',
    'output': status == 'completed' ? '00:02 +226: All tests passed!' : '',
    'exitCode': status == 'completed' ? 0 : null,
    'status': status,
  };

  Json _usage(int ms, int input, int output) => {
    'durationMs': ms,
    'models': {
      'claude-sonnet-4-5': {
        'input': input,
        'cacheRead': input * 2,
        'cacheWrite': 0,
        'output': output,
        'costUsd': null,
      },
    },
  };

  Json _queued(String text, [List<Object?>? attachments]) => {
    'id': _id('q'),
    'text': text,
    'createdAt': _now,
    'settings': <String, Object?>{},
    'status': 'queued',
    'error': null,
    'mode': 'normal',
    if (attachments != null && attachments.isNotEmpty)
      'attachments': attachments,
  };

  late final _tools = DemoTools(
    changed: () => _rpc?.event('projectTools:changed', {'kind': 'tools'}),
    projectAdded: (project) {
      _projects.add(project);
      _rpc?.event('engine:event', {'kind': 'projects', 'projects': _projects});
    },
  );

  late final _feedback = DemoFeedback(
    changed: (unread) =>
        _rpc?.event('feedback:changed', {'kind': 'feedback', 'unread': unread}),
  );

  Object? _handle(String method, List args) {
    final id = args.isEmpty ? null : args.first;
    final tool = _tools.handle(method, args);
    if (!identical(tool, notTool)) return tool;
    final feedback = _feedback.handle(method, args);
    if (!identical(feedback, notTool)) return feedback;
    switch (method) {
      case 'hello':
        _startStream();
        return {
          'version': linkVersion,
          'name': L10n.desktop,
          'access': 'act',
          'tools': true,
          'queueMoveBefore': true,
        };
      case 'engine:sessions':
        return _summaries();
      case 'engine:projects':
        return _projects;
      case 'engine:openSessionTail':
        final snap = _snaps[id] ?? _snaps.values.first;
        return {
          'snapshot': snap,
          'seq': _seq[id] ?? 0,
          'before': null,
          'truncated': <String>[],
        };
      case 'unwatch' || 'away':
        return null;
      case 'defaults':
        return {'engine': 'claude'};
      case 'sources':
        return _sources(args.first == 'codex');
      case 'engine:catalog':
        return {
          'models': args.first == 'codex'
              ? L10n.codexModels
              : L10n.claudeModels,
        };
    }
    if (id is! String || !_snaps.containsKey(id)) {
      if (method == 'engine:createSession') return _create(obj(args.first));
      throw const LinkException('MOBILE_UNSUPPORTED');
    }
    final snap = _snaps[id]!;
    final running = snap['turnId'] != null;
    switch (method) {
      case 'engine:send':
        _undo.remove(id);
        final input = obj(args[1]);
        final text = str(input['text']) ?? '';
        final attachments = input['attachments'] as List?;
        if (running || objList(snap['pending']).isNotEmpty) {
          _queue(id, [..._queueOf(id), _queued(text, attachments)]);
        } else {
          _turn(id, text, attachments: attachments);
        }
        return null;
      case 'engine:interrupt':
        _stop(id);
        return null;
      case 'engine:answer':
        final requestId = args[1] as String;
        _push(id, {'type': 'approval_resolved', 'requestId': requestId});
        if (objList(_snaps[id]!['pending']).isEmpty) {
          final w = _waitingCommand.remove(id);
          w != null ? _finish(id, w) : _afterApproval(id);
        }
        return null;
      case 'engine:runQueuedNow':
        final q = _queueOf(id);
        final item = q.firstWhere((x) => x['id'] == args[1]);
        if (running) _stop(id);
        _queue(id, [...q.where((x) => x['id'] != args[1])]);
        _turn(
          id,
          str(item['text']) ?? '',
          attachments: item['attachments'] as List?,
        );
        return null;
      case 'engine:steerQueued':
        final q = _queueOf(id);
        final item = q.firstWhere((x) => x['id'] == args[1]);
        _queue(id, [...q.where((x) => x['id'] != args[1])]);
        _push(id, {
          'type': 'item_started',
          'item': {
            'kind': 'user',
            'id': _id('u'),
            'text': item['text'],
            'createdAt': _now,
            'mode': 'guidance',
          },
        });
        return null;
      case 'engine:cancelQueued':
        final q = _queueOf(id);
        final item = q.firstWhere((x) => x['id'] == args[1]);
        _queue(id, [...q.where((x) => x['id'] != args[1])]);
        return item['text'];
      case 'engine:moveQueued':
        final q = List<Json>.of(_queueOf(id));
        final item = q.firstWhere((x) => x['id'] == args[1]);
        q.remove(item);
        final before = obj(args[2])['before'];
        final at = before == null
            ? q.length
            : q.indexWhere((x) => x['id'] == before);
        q.insert(at < 0 ? q.length : at, item);
        _queue(id, q);
        return null;
      case 'engine:dismissQueued':
        _queue(id, [..._queueOf(id).where((x) => x['id'] != args[1])]);
        return null;
      case 'engine:resumeQueue':
        _queue(id, _queueOf(id), paused: false);
        if (!running) _next(id);
        return null;
      case 'engine:updateSession':
        final patch = Map<String, Object?>.of(obj(args[1]));
        final source = objOrNull(patch.remove('source'));
        if (source != null) {
          patch.addAll(_switchSource(source, _record(id), patch['model']));
        }
        _setRecord(id, patch);
        return null;
      case 'engine:renameSession':
        _setRecord(id, {'title': args[1]});
        return null;
      case 'engine:setSessionPinned':
        _setRecord(id, {'pinnedAt': args[1] == true ? _now : null});
        return null;
      case 'engine:rewind':
        if (running) throw const LinkException('请先停止当前任务再回退');
        final items = objList(snap['items']);
        final at = items.indexWhere((x) => x['id'] == args[1]);
        if (at < 0 || items[at]['kind'] != 'user') {
          throw const LinkException('只能回退到自己发送的消息');
        }
        _undo[id] = items;
        _push(id, {'type': 'items_truncated', 'fromItemId': args[1]});
        return {
          'text': items[at]['text'] ?? '',
          if (items[at]['attachments'] is List)
            'attachments': items[at]['attachments'],
          'dropped': 0,
          'undoable': true,
        };
      case 'engine:undoRewind':
        final saved = _undo.remove(id);
        if (saved == null) {
          throw const LinkException('回退之后有了新的对话，不能撤销了');
        }
        _push(id, {'type': 'items_reset', 'items': saved});
        return null;
      case 'engine:archiveSession':
        if (running && args.length > 2 && args[2] != true) {
          throw const LinkException('SESSION_RUNNING');
        }
        if (running) _stop(id);
        _setRecord(id, {'archivedAt': _now});
        return null;
      default:
        throw const LinkException('MOBILE_UNSUPPORTED');
    }
  }

  /// 演示电脑上「配好的」额度来源（docs/mobile-app.md §14.4）：两条平台线路、一个自定义接口
  Json _sources(bool codex) {
    final models = [
      for (final m in codex ? L10n.codexModels : L10n.claudeModels)
        m['id'] as String,
    ];
    return {
      'platform': [
        {'id': '34', 'name': '便宜线路', 'rate': 0.6, 'models': models},
        {
          'id': '35',
          'name': '官方直连',
          'rate': 1.5,
          'models': models.take(1).toList(),
        },
      ],
      'platformError': null,
      'providers': [
        {
          'id': 'demo-api',
          'name': '我的中转',
          'models': [models.last],
        },
      ],
    };
  }

  /// 换来源：照电脑上的网关换成记录字段（不核对，演示用）
  Json _switchSource(Json source, Json record, Object? model) {
    final codex = record['engine'] == 'codex';
    final all = objList(_sources(codex)['platform']);
    final providers = objList(_sources(codex)['providers']);
    List<String> listOf(Json? j) => [
      for (final m in (j?['models'] as List? ?? const [])) '$m',
    ];
    String? pickFrom(List<String> models) {
      if (model is String) return model;
      final now = str(record['model']);
      return now != null && models.contains(now)
          ? now
          : (models.isEmpty ? null : models.first);
    }

    switch (source['kind']) {
      case 'platform':
        final line = all.firstWhere((g) => g['id'] == source['groupId']);
        return {
          'platform': {'groupId': line['id'], 'account': 'demo@pixelsky.app'},
          'provider': null,
          'model': pickFrom(listOf(line)),
        };
      case 'provider':
        final p = providers.firstWhere((x) => x['id'] == source['id']);
        return {
          'platform': null,
          'provider': {'id': p['id']},
          'model': pickFrom(listOf(p)),
        };
      default:
        return {'platform': null, 'provider': null};
    }
  }

  /// 回退前的条目（撤销用）；发了新消息就作废，同电脑上的宿主
  final _undo = <String, List<Json>>{};

  /// 发消息时带 approve 的那一轮：在等允许的命令
  final _waitingCommand =
      <String, ({String command, String turnId, int start})>{};

  /// 允许之后把这一轮跑完
  void _finish(String id, ({String command, String turnId, int start}) w) {
    final reply = _id('a');
    final text = L10n.replyWords.join();
    _status(id, 'running');
    _later(id, [
      (
        1200,
        () => _push(id, {
          'type': 'item_completed',
          'item': _cmd(w.command, 'completed'),
        }),
      ),
      (
        400,
        () {
          _push(id, {
            'type': 'item_completed',
            'item': {
              'kind': 'assistant',
              'id': reply,
              'text': text,
              'status': 'completed',
            },
          });
          _push(id, {
            'type': 'item_completed',
            'item': {
              'kind': 'turn_stats',
              'id': _id('st'),
              'turnId': w.turnId,
              'outcome': 'completed',
              'usage': _usage(_now - w.start, 18400, 920),
            },
          });
          _push(id, {
            'type': 'turn_completed',
            'turnId': w.turnId,
            'outcome': 'completed',
          });
          _status(id, 'idle');
          _setRecord(id, {'lastOutcome': 'completed', 'lastReply': text});
          _next(id);
        },
      ),
    ]);
  }

  /// 「给设置页加搜索」：审批和提问都答完了，接着把活干完
  void _afterApproval(String id) {
    final turnId = _snaps[id]!['turnId'] ?? _id('t');
    final reply = _id('a');
    final file = _id('f');
    _status(id, 'running');
    _later(id, [
      (
        600,
        () => _push(id, {
          'type': 'item_completed',
          'item': {..._cmdInstall(), 'status': 'completed'},
        }),
      ),
      (
        800,
        () => _push(id, {
          'type': 'item_completed',
          'item': {
            'kind': 'file_change',
            'id': file,
            'status': 'completed',
            'changes': L10n.searchChanges,
          },
        }),
      ),
      (
        600,
        () => _push(id, {
          'type': 'item_completed',
          'item': {
            'kind': 'assistant',
            'id': reply,
            'text': L10n.reply2,
            'status': 'completed',
          },
        }),
      ),
      (
        200,
        () {
          _push(id, {
            'type': 'item_completed',
            'item': {
              'kind': 'turn_stats',
              'id': _id('st'),
              'turnId': turnId,
              'outcome': 'completed',
              'usage': _usage(64000, 41000, 2300),
            },
          });
          _push(id, {
            'type': 'turn_completed',
            'turnId': turnId,
            'outcome': 'completed',
          });
          _status(id, 'idle');
          _setRecord(id, {
            'lastOutcome': 'completed',
            'lastReply': L10n.reply2,
          });
          _next(id);
        },
      ),
    ]);
  }

  Json _cmdInstall() => {
    'kind': 'command',
    'id': 'c2',
    'command': 'pnpm add fuse.js',
    'description': '',
    'output': '+ fuse.js 7.1.0',
    'exitCode': 0,
    'status': 'running',
  };

  Json _create(Json o) {
    final id = _id('n');
    final record = {
      'id': id,
      'projectId': o['projectId'],
      'cwd': 'D:\\work',
      'engine': o['engine'] ?? 'claude',
      'engineSessionId': null,
      'title': L10n.newTitle,
      'model': o['model'],
      'effort': o['effort'],
      'permissionMode': o['permissionMode'] ?? 'edits',
      'ultracode': false,
      'fast': o['fast'] ?? false,
      'thinkingSummaries': true,
      'createdAt': _now,
      'updatedAt': _now,
    };
    _snaps[id] = emptySnapshot(record);
    _pushList();
    return record;
  }

  // -------------------------------------------------------------------------
  // 演示数据
  // -------------------------------------------------------------------------

  void _add(Json s) {
    final record = {
      'id': s['id'],
      'projectId': s['projectId'],
      'cwd': 'D:\\work',
      'engine': s['engine'],
      'engineSessionId': null,
      'title': s['title'],
      'model': s['model'],
      'effort': 'high',
      'permissionMode': 'edits',
      'ultracode': false,
      'fast': false,
      'thinkingSummaries': true,
      'createdAt': s['updatedAt'],
      'updatedAt': s['updatedAt'],
      'lastOutcome': s['outcome'],
      'lastReply': s['lastReply'],
      if (s['pinned'] == true) 'pinnedAt': 1,
    };
    _snaps[s['id'] as String] = {
      ...emptySnapshot(record, objList(s['items'])),
      'state': s['state'],
      'turnId': s['state'] == 'running' || s['state'] == 'waiting'
          ? 't0'
          : null,
      'pending': s['pending'] ?? const <Json>[],
      'queue': s['queue'] ?? const <Json>[],
      'context': s['context'],
    };
  }

  void _seed() {
    final now = _now;
    _projects = [
      {
        'id': 'p1',
        'name': 'PixelSky',
        'path': 'D:\\work\\pixelsky',
        'addedAt': 0,
      },
      {'id': 'p2', 'name': L10n.site, 'path': 'D:\\work\\site', 'addedAt': 0},
    ];
    Json cmd(String id, String c, String d, String out) => {
      'kind': 'command',
      'id': id,
      'command': c,
      'description': d,
      'output': out,
      'exitCode': 0,
      'status': 'completed',
    };
    Json read(String id, String path) => {
      'kind': 'tool',
      'id': id,
      'tool': 'read',
      'name': 'Read',
      'title': path,
      'output': '',
      'status': 'completed',
    };
    _add({
      'id': 's1',
      'projectId': 'p1',
      'engine': 'claude',
      'model': 'claude-sonnet-4-5-20250929',
      'title': L10n.title1,
      'state': 'running',
      'updatedAt': now - 20 * 1000,
      'pinned': true,
      'context': {
        'used': 84000,
        'window': 200000,
        'stale': false,
        'compacting': false,
      },
      'queue': [
        {
          'id': 'q1',
          'text': L10n.queued1,
          'createdAt': now,
          'settings': <String, Object?>{},
          'status': 'queued',
          'error': null,
          'mode': 'normal',
        },
      ],
      'items': [
        {
          'kind': 'user',
          'id': 'u1',
          'text': L10n.ask1,
          'createdAt': now - 300000,
        },
        {
          'kind': 'reasoning',
          'id': 'r1',
          'text': L10n.think1,
          'status': 'completed',
          'durationMs': 4200,
        },
        read('t1', 'apps/app/lib/connection/desktop_link.dart'),
        read('t2', 'apps/mobile/src/connection/link.ts'),
        cmd(
          'c1',
          'flutter test test/connection',
          L10n.runTests,
          '00:01 +29: All tests passed!',
        ),
        {
          'kind': 'file_change',
          'id': 'f1',
          'status': 'completed',
          'changes': [
            {
              'path': 'apps/app/lib/connection/desktop_link.dart',
              'kind': 'update',
              'diff': '@@ -1 +1 @@\n-a\n+b',
              'added': 12,
              'removed': 3,
            },
          ],
        },
        {
          'kind': 'todo',
          'id': 'todo',
          'status': 'running',
          'steps': [
            {'text': L10n.step1, 'status': 'completed'},
            {'text': L10n.step2, 'status': 'in_progress'},
            {'text': L10n.step3, 'status': 'pending'},
          ],
        },
        {
          'kind': 'assistant',
          'id': 'a1',
          'text': L10n.reply1Start,
          'status': 'running',
        },
      ],
    });
    _add({
      'id': 's2',
      'projectId': 'p1',
      'engine': 'codex',
      'model': 'gpt-5-codex',
      'title': L10n.title2,
      'state': 'waiting',
      'updatedAt': now - 3 * 60000,
      'pending': L10n.pending2,
      'items': [
        {
          'kind': 'user',
          'id': 'u1',
          'text': L10n.title2,
          'createdAt': now - 400000,
        },
        cmd('c1', 'git status', '', 'M src/settings.tsx'),
        read('t1', 'src/settings/SettingsPage.tsx'),
        _cmdInstall(),
      ],
    });
    _add({
      'id': 's3',
      'projectId': 'p1',
      'engine': 'claude',
      'title': L10n.title3,
      'state': 'idle',
      'outcome': 'completed',
      'lastReply': L10n.reply3.split('\n').first,
      'updatedAt': now - 2 * 3600000,
      'items': [
        {
          'kind': 'user',
          'id': 'u1',
          'text': L10n.title3,
          'createdAt': now - 7300000,
        },
        read('t1', 'packages/link/src/noise.ts'),
        read('t2', 'packages/link/src/pairing.ts'),
        {
          'kind': 'file_change',
          'id': 'f1',
          'status': 'completed',
          'changes': L10n.docChanges,
        },
        {
          'kind': 'assistant',
          'id': 'a1',
          'text': L10n.reply3,
          'status': 'completed',
        },
        {
          'kind': 'turn_stats',
          'id': 'st1',
          'turnId': 't1',
          'outcome': 'completed',
          'usage': _usage(48000, 21000, 1400),
        },
      ],
    });
    _add({
      'id': 's4',
      'projectId': 'p2',
      'engine': 'codex',
      'title': L10n.title4,
      'state': 'idle',
      'outcome': 'failed',
      'lastReply': '',
      'updatedAt': now - 26 * 3600000,
      'items': [
        {
          'kind': 'user',
          'id': 'u1',
          'text': L10n.title4,
          'createdAt': now - 93600000,
        },
        {'kind': 'notice', 'id': 'n1', 'level': 'error', 'text': L10n.error4},
      ],
    });
    _add({
      'id': 's5',
      'projectId': 'chat',
      'engine': 'claude',
      'title': L10n.title5,
      'state': 'idle',
      'outcome': 'completed',
      'lastReply': L10n.reply5,
      'updatedAt': now - 3 * 86400000,
      'items': [
        {
          'kind': 'user',
          'id': 'u1',
          'text': L10n.title5,
          'createdAt': now - 259200000,
        },
        {
          'kind': 'assistant',
          'id': 'a1',
          'text': L10n.reply5,
          'status': 'completed',
        },
      ],
    });
  }

  // s1 一直在回复：每 0.4 秒推一段文字，隔一会儿插一个命令（停止后不再推）
  Timer? _stream;
  int _tick = 0;
  String _current = 'a1';

  /// 停掉所有在跑的演示（测试收尾用）
  void dispose() {
    _stream?.cancel();
    for (final id in [..._timers.keys]) {
      _cancel(id);
    }
  }

  void _startStream() {
    if (_stream != null || _snaps['s1']!['turnId'] == null) return;
    _stream = Timer.periodic(const Duration(milliseconds: 400), (_) {
      if (_rpc == null || _socket?.closed != false) return;
      if (_snaps['s1']!['turnId'] != 't0') {
        _stream?.cancel();
        return;
      }
      _tick++;
      final words = L10n.streamWords;
      if (_tick % 20 == 0) {
        final id = 'live$_tick';
        Json c(String status) => {
          'kind': 'command',
          'id': id,
          'command': 'flutter analyze',
          'description': L10n.analyze,
          'output': status == 'completed' ? 'No issues found!' : '',
          'exitCode': status == 'completed' ? 0 : null,
          'status': status,
        };
        // 上一段回复先收尾，再开始命令
        _push('s1', {
          'type': 'item_completed',
          'item': {
            ...obj(
              objList(_snaps['s1']!['items']).lastWhere(
                (x) => x['id'] == _current,
                orElse: () => {'kind': 'assistant', 'id': _current, 'text': ''},
              ),
            ),
            'status': 'completed',
          },
        });
        _push('s1', {'type': 'item_started', 'item': c('running')});
        Timer(const Duration(milliseconds: 1600), () {
          if (_snaps['s1']!['turnId'] != 't0') return;
          _push('s1', {'type': 'item_completed', 'item': c('completed')});
          _push('s1', {
            'type': 'item_started',
            'item': {
              'kind': 'assistant',
              'id': 'a$_tick',
              'text': '',
              'status': 'running',
            },
          });
          _current = 'a$_tick';
        });
      } else if (_tick % 20 < 16) {
        _push('s1', {
          'type': 'item_delta',
          'itemId': _current,
          'field': 'text',
          'delta': words[_tick % words.length],
        });
      }
    });
  }
}

/// 演示文字（演示模式只给自己看，不走 i18n）
abstract final class L10n {
  static const desktop = '工作室台式机';
  static const site = '官网';
  static const title1 = '修复手机端断线重连';
  static const ask1 = '手机切到后台再回来，有时一直显示「正在连接」，帮我查一下原因并修好。';
  static const think1 = '先看连接层怎么判断断线：心跳、看门狗、重连退避……';
  static const runTests = '跑连接层的测试';
  static const step1 = '找到看门狗没有触发的原因';
  static const step2 = '回到前台时主动探一下连接';
  static const step3 = '补测试';
  static const queued1 = '顺便把重连的日志也打出来';
  static const reply1Start = '找到原因了：系统挂起 App 时 WebSocket 没有收到关闭帧，';
  static const streamWords = [
    '回到前台后',
    '看门狗',
    '要等 60 秒',
    '才判定断线。',
    '\n\n',
    '改法是',
    '在 **回到前台** 时',
    '先调一次 `hello`，',
    '失败就',
    '立刻重新握手。',
    '\n\n',
  ];
  static const analyze = '静态检查';
  static const title2 = '给设置页加搜索';
  static const pending2 = [
    {
      'requestId': 'req1',
      'itemId': 'c2',
      'kind': 'command',
      'title': '运行命令',
      'command': 'pnpm add fuse.js',
      'description': '装一个模糊搜索的库',
      'alwaysScopes': ['project'],
    },
    {
      'requestId': 'req2',
      'itemId': null,
      'kind': 'question',
      'title': '搜索框放哪里？',
      'alwaysScopes': <String>[],
      'questions': [
        {
          'question': '搜索框放在哪？',
          'header': '位置',
          'multiSelect': false,
          'allowOther': true,
          'options': [
            {'label': '页面顶部，固定不动（推荐）', 'description': '滚动时一直看得到'},
            {'label': '左侧导航上方', 'description': ''},
          ],
        },
        {
          'question': '要搜哪些内容？',
          'header': '范围',
          'multiSelect': true,
          'options': [
            {'label': '设置项名称（推荐）', 'description': ''},
            {'label': '设置说明（推荐）', 'description': ''},
            {'label': '快捷键', 'description': ''},
          ],
        },
      ],
    },
  ];
  static const searchChanges = [
    {
      'path': 'src/settings/SettingsPage.tsx',
      'kind': 'update',
      'diff': '@@ -12,6 +12,14 @@\n import { Section } from \'./Section\'\n+import Fuse from \'fuse.js\'\n+\n export function SettingsPage() {\n-  const items = useSettings()\n+  const all = useSettings()\n+  const [q, setQ] = useState(\'\')\n+  const items = q ? fuse.search(q) : all',
      'added': 17,
      'removed': 3,
    },
    {
      'path': 'src/settings/SettingsPage.test.tsx',
      'kind': 'add',
      'diff': '@@ -0,0 +1,10 @@\n+it(\'filters by name\', () => {\n+  render(<SettingsPage />)\n+})',
      'added': 10,
      'removed': 0,
    },
  ];
  static const reply2 =
      '加好了。搜索框固定在页面顶部，按设置项名称和说明模糊匹配：\n\n- 输入时实时过滤，没有结果时显示「没有找到」\n- 新增 `SettingsPage.test.tsx`，测试 3 项全部通过';
  static const think2 = '先确认一下上下文，再跑一遍测试。';
  static const replyWords = [
    '好的，',
    '我看了一下，',
    '测试都通过了。',
    '\n\n',
    '- 重连日志',
    '加在 `DesktopLink`',
    ' 里\n',
    '- 每次握手',
    '记一行耗时',
  ];
  static const title3 = '解释一下 Noise 握手';
  static const docChanges = [
    {
      'path': 'docs/noise.md',
      'kind': 'add',
      'diff': '@@ -0,0 +1,3 @@\n+# Noise KK\n+\n+两条消息完成握手。',
      'added': 42,
      'removed': 0,
    },
  ];
  static const reply3 = '''Noise KK 握手只有两条消息：

1. 手机发 **Handshake1**：临时公钥 + 一段加密的空内容
2. 电脑回 **Handshake2**：自己的临时公钥 + 加密的空内容

| 步骤 | 混入的密钥 | 作用 |
|---|---|---|
| es | 手机临时 × 电脑长期 | 只有真电脑能解 |
| ss | 手机长期 × 电脑长期 | 证明手机是配过对的 |
| ee | 双方临时 | 前向保密 |

```dart
final r = Responder(local: key, remote: phone, prologue: prologue);
r.readMessage1(message1);
final out = r.writeMessage2();
```

之后双方各拿到一把发送密钥、一把接收密钥。''';
  static const title4 = '整理 0.6.9 发版说明';
  static const error4 = '请求失败：上游返回 529（服务繁忙），已重试 3 次。';
  static const title5 = '周报润色';
  static const reply5 = '这一版更简洁了：先说结论，再列三件做完的事。';
  static const newTitle = '新对话';
  static const claudeModels = [
    {
      'id': 'claude-opus-4-1-20250805',
      'label': 'Opus 4.1',
      'description': '最强，适合难题',
      'efforts': ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      'id': 'claude-sonnet-4-5-20250929',
      'label': 'Sonnet 4.5',
      'description': '日常写代码',
      'efforts': ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      'id': 'claude-haiku-4-5',
      'label': 'Haiku 4.5',
      'description': '快、便宜',
      'efforts': <String>[],
    },
  ];
  static const codexModels = [
    {
      'id': 'gpt-5-codex',
      'label': 'GPT-5 Codex',
      'description': '',
      'efforts': ['low', 'medium', 'high'],
    },
  ];
}
