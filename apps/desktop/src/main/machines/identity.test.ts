import { describe, expect, it } from 'vitest'
import { argumentMachine, machineOf, remoteIds, remoteArguments } from './identity'
const machine = 'ssh-11111111-1111-4111-8111-111111111111'
const id = '22222222-2222-4222-8222-222222222222'
describe('machine resource ownership', () => {
  it('计划每一步的起点跟着条目 id 加前缀，开头的 null 不动', () => {
    const marks = {
      stepMarks: [
        { step: '查', afterItemId: id },
        { step: '改', afterItemId: null },
      ],
    }
    expect(remoteIds(marks, machine, true)).toEqual({
      stepMarks: [
        { step: '查', afterItemId: machine + '~' + id },
        { step: '改', afterItemId: null },
      ],
    })
    expect(remoteIds(remoteIds(marks, machine, true), machine, false)).toEqual(marks)
  })
  it('encodes wsl resource ids both ways and keeps them apart from ssh', () => {
    const wsl = 'wsl-33333333-3333-4333-8333-333333333333'
    expect(remoteIds({ id }, wsl, true)).toEqual({ id: wsl + '~' + id })
    expect(remoteIds({ id: wsl + '~' + id }, wsl, false)).toEqual({ id })
    expect(remoteIds({ id: wsl + '~' + id }, machine, false)).toEqual({ id: wsl + '~' + id })
    expect(remoteIds({ id: machine + '~' + id }, wsl, false)).toEqual({ id: machine + '~' + id })
    expect(machineOf(wsl + '~' + id)).toBe(wsl)
    expect(argumentMachine([{ projectId: wsl + '~' + id }])).toBe(wsl)
  })
  it('usage session rows: sessionId gets the machine prefix, key and the session filter stay raw', () => {
    const row = { key: id, sessionId: id, title: 't' }
    expect(remoteIds([row], machine, true)).toEqual([{ key: id, sessionId: machine + '~' + id, title: 't' }])
    expect(remoteIds({ filter: { session: id } }, machine, false)).toEqual({ filter: { session: id } })
  })
  it('keeps identical remote and local resources distinct without rewriting user content', () => {
    const raw = {
      record: { id, projectId: id, engineSessionId: id },
      input: { id },
      text: id,
      content: [{ id }],
      output: { id },
    }
    const encoded = remoteIds(raw, machine, true)
    expect(encoded.record.id).toBe(machine + '~' + id)
    expect(encoded.input).toEqual(raw.input)
    expect(encoded.content).toEqual(raw.content)
    expect(encoded.record.engineSessionId).toBe(id)
    expect(encoded.text).toBe(id)
    expect(remoteIds(encoded, machine, false)).toEqual(raw)
  })
  it('prefixes branch.startAfter like the item ids it points at, but not copyId or user text', () => {
    const item = '44444444-4444-4444-8444-444444444444'
    const raw = {
      record: { id, branch: { startAfter: item, copyId: id, gitBranch: 'feature', mergedAt: null } },
      items: [{ kind: 'user', id: item, text: item }],
    }
    const encoded = remoteIds(raw, machine, true)
    expect(encoded.record.branch.startAfter).toBe(machine + '~' + item)
    expect(encoded.items[0].id).toBe(encoded.record.branch.startAfter)
    // copyId 现有行为不变（它在字段集合里，会加前缀）；分支名、null 原样
    expect(encoded.record.branch.copyId).toBe(machine + '~' + id)
    expect(encoded.record.branch.gitBranch).toBe('feature')
    expect(encoded.record.branch.mergedAt).toBeNull()
    expect(remoteIds(encoded, machine, false)).toEqual(raw)
    expect(remoteIds({ branch: { startAfter: null } }, machine, true)).toEqual({ branch: { startAfter: null } })
    // 不是 uuid 的值（用户文字）不会被改
    expect(remoteIds({ branch: { startAfter: 'some-item' } }, machine, true)).toEqual({
      branch: { startAfter: 'some-item' },
    })
  })
  it('prefixes the owner of a native session, so the resume picker opens the remote conversation', () => {
    const native = { id: 'native-claude-id', ownerId: id }
    const encoded = remoteIds([native], machine, true)
    expect(encoded[0].ownerId).toBe(machine + '~' + id)
    expect(encoded[0].id).toBe('native-claude-id')
    expect(remoteIds({ ownerId: id }, machine, true)).toEqual({ ownerId: machine + '~' + id })
  })
  it('routes references by ownership even after another machine is selected', () => {
    expect(argumentMachine([{ projectId: machine + '~' + id }])).toBe(machine)
    expect(argumentMachine([machine + '~' + id, 'hello'])).toBe(machine)
    expect(argumentMachine([{ projectId: id }])).toBeNull()
    expect(machineOf(id)).toBe('local')
  })
  it('preserves literal content that happens to equal a resource id', () => {
    const value = machine + '~' + id
    expect(remoteIds([{ id: value, text: value, input: { sessionId: value } }], machine, false)).toEqual([
      { id, text: value, input: { sessionId: value } },
    ])
    expect(remoteIds([value], machine, false)).toEqual([id])
    expect(remoteIds(value, 'ssh-other', false)).toBe(value)
    expect(remoteArguments('engine:send', [value, value], machine)).toEqual([id, value])
    expect(remoteArguments('engine:renameSession', [value, value], machine)).toEqual([id, value])
    expect(remoteArguments('engine:answer', [value, value, { type: 'deny' }], machine)).toEqual([
      id,
      id,
      { type: 'deny' },
    ])
  })
  it('does not route free text that merely starts with a machine prefix', () => {
    expect(argumentMachine([machine + '~hello', null])).toBeNull()
    expect(argumentMachine([machine + '~' + id + ' extra', null])).toBeNull()
    expect(argumentMachine([machine + '~', null])).toBeNull()
    expect(argumentMachine([machine + '~' + id, null])).toBe(machine)
  })
  it('only encodes uuid values in resource fields', () => {
    expect(remoteIds({ id: 'not-a-uuid', sessionId: id, other: id }, machine, true)).toEqual({
      id: 'not-a-uuid',
      sessionId: machine + '~' + id,
      other: id,
    })
    expect(remoteIds({ ids: [id, 'x'] }, machine, true)).toEqual({ ids: [machine + '~' + id, 'x'] })
    expect(remoteIds({ ids: [machine + '~' + id] }, machine, false)).toEqual({ ids: [id] })
    expect(remoteIds(null, machine, true)).toBeNull()
  })
  it('prefixes the phone tail truncated item ids, so 查看完整 finds the remote item', () => {
    const tail = { snapshot: { items: [{ kind: 'tool', id }] }, truncated: [id, 'x'] }
    const encoded = remoteIds(tail, machine, true)
    expect(encoded.truncated).toEqual([machine + '~' + id, 'x'])
    expect(encoded.truncated[0]).toBe(encoded.snapshot.items[0].id)
    expect(remoteIds(encoded, machine, false)).toEqual(tail)
    expect(remoteIds({ truncated: true }, machine, true)).toEqual({ truncated: true })
  })
  it('prefixes pendingIds like pending.requestId, so the inbox signature matches before and after opening', () => {
    const summary = { pending: { requestId: id }, pendingIds: [id] }
    const encoded = remoteIds(summary, machine, true)
    expect(encoded.pendingIds[0]).toBe(encoded.pending.requestId)
    expect(encoded.pendingIds[0]).toBe(machine + '~' + id)
    expect(remoteIds(encoded, machine, false)).toEqual(summary)
  })
  it('prefixes the built-in chat project id (not a uuid) only in projectId fields', () => {
    const chat = machine + '~chat'
    expect(remoteIds({ record: { id, projectId: 'chat' }, id: 'chat' }, machine, true)).toEqual({
      record: { id: machine + '~' + id, projectId: chat },
      id: 'chat',
    })
    expect(remoteArguments('engine:createSession', [{ projectId: chat }], machine)).toEqual([{ projectId: 'chat' }])
    expect(remoteArguments('engine:createSession', [{ projectId: 'ssh-other~chat' }], machine)).toEqual([
      { projectId: 'ssh-other~chat' },
    ])
    expect(argumentMachine([chat])).toBe(machine)
    expect(argumentMachine([{ projectId: chat }])).toBe(machine)
    expect(argumentMachine(['chat'])).toBeNull()
  })
  it('routes object arguments by sessionId, projectId, then id', () => {
    expect(argumentMachine([{ sessionId: machine + '~' + id }])).toBe(machine)
    expect(argumentMachine([{ id: machine + '~' + id }])).toBe(machine)
    expect(argumentMachine([{ other: machine + '~' + id }])).toBeNull()
    expect(argumentMachine([])).toBeNull()
    expect(argumentMachine([42])).toBeNull()
  })
  it('decodes only declared positional resource parameters', () => {
    const value = machine + '~' + id
    expect(remoteArguments('projectTools:searchTasks', [value, value], machine)).toEqual([value, id])
    expect(remoteArguments('engine:steerQueued', [value, value, value, value], machine)).toEqual([id, id, id, value])
    expect(remoteArguments('engine:cancelQueued', [value, value], machine)).toEqual([id, id])
    // 远端用户图片的 id 是 uuid，也要去前缀；手机传的是第几张（数字原样）
    expect(remoteArguments('engine:image', [value, value, value], machine)).toEqual([id, id, id])
    expect(remoteArguments('engine:image', [value, value, 0], machine)).toEqual([id, id, 0])
    expect(remoteArguments('x', [{ projectId: value, input: { id: value } }], machine)).toEqual([
      { projectId: id, input: { id: value } },
    ])
  })
})
