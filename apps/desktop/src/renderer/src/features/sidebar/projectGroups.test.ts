import { describe, expect, it } from 'vitest'
import {
  addToGroup,
  arrangeProjects,
  createGroup,
  dissolveGroup,
  dropPlace,
  dropProjects,
  groupOf,
  moveGroup,
  moveProjects,
  rangeBetween,
  removeFromGroups,
  renameGroup,
  sortByOrder,
} from './projectGroups'

const projects = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }))
const groups = [
  { id: 'g1', name: '像素星空', projects: ['d', 'b'] },
  { id: 'g2', name: '别的机器', projects: ['x'] },
]

describe('侧栏分区排列', () => {
  it('分区在前、组内按项目列表的顺序，其余项目在后；一个都不在列表里的分区不显示', () => {
    expect(arrangeProjects(projects, groups)).toEqual([
      { kind: 'group', group: groups[0], projects: [{ id: 'b' }, { id: 'd' }] },
      { kind: 'project', project: { id: 'a' } },
      { kind: 'project', project: { id: 'c' } },
      { kind: 'project', project: { id: 'e' } },
    ])
  })

  it('置顶的项目最前、后置顶的在上面，不算进分区；看不到的置顶项目跳过（project-pin.md）', () => {
    expect(arrangeProjects(projects, groups, [], ['e', 'zz', 'b'])).toEqual([
      { kind: 'project', project: { id: 'e' }, pinned: true },
      { kind: 'project', project: { id: 'b' }, pinned: true },
      { kind: 'group', group: groups[0], projects: [{ id: 'd' }] },
      { kind: 'project', project: { id: 'a' } },
      { kind: 'project', project: { id: 'c' } },
    ])
  })

  it('同一个项目只算在第一个分区里', () => {
    const twice = [...groups, { id: 'g3', name: '重复', projects: ['b'] }]
    expect(arrangeProjects(projects, twice).filter(e => e.kind === 'group')).toHaveLength(1)
  })

  it('找项目在哪个分区', () => {
    expect(groupOf(groups, 'd')?.id).toBe('g1')
    expect(groupOf(groups, 'a')).toBeUndefined()
  })
})

describe('分区增删改', () => {
  it('新建分区放最后，项目从原来的分区移出，空分区去掉', () => {
    expect(createGroup(groups, { id: 'g3', name: '新' }, ['b', 'd', 'a', 'a'])).toEqual([
      { id: 'g2', name: '别的机器', projects: ['x'] },
      { id: 'g3', name: '新', projects: ['b', 'd', 'a'] },
    ])
  })

  it('加入已有分区接在后面；分区不存在时不变', () => {
    expect(addToGroup(groups, 'g2', ['b'])).toEqual([
      { id: 'g1', name: '像素星空', projects: ['d'] },
      { id: 'g2', name: '别的机器', projects: ['x', 'b'] },
    ])
    expect(addToGroup(groups, 'nope', ['a'])).toEqual(groups)
  })

  it('移出、改名、解散', () => {
    expect(removeFromGroups(groups, ['x'])).toEqual([groups[0]])
    expect(renameGroup(groups, 'g1', '客户')[0].name).toBe('客户')
    expect(dissolveGroup(groups, 'g1')).toEqual([groups[1]])
  })
})

describe('拖动换位置', () => {
  it('按记下的先后排，没排过的（新加的）接在后面', () => {
    expect(sortByOrder(projects, ['c', 'a']).map(p => p.id)).toEqual(['c', 'a', 'b', 'd', 'e'])
    expect(sortByOrder(projects, []).map(p => p.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('分区里和分区外的项目都按记下的先后', () => {
    const order = ['d', 'e', 'b', 'a']
    expect(arrangeProjects(projects, groups, order)).toEqual([
      { kind: 'group', group: groups[0], projects: [{ id: 'd' }, { id: 'b' }] },
      { kind: 'project', project: { id: 'e' } },
      { kind: 'project', project: { id: 'a' } },
      { kind: 'project', project: { id: 'c' } },
    ])
  })

  it('上半是前面、下半是后面', () => {
    expect(dropPlace({ top: 100, height: 32 }, 110)).toBe('before')
    expect(dropPlace({ top: 100, height: 32 }, 120)).toBe('after')
  })

  it('拖到目标前面 / 后面，拖的几个保持原来的先后', () => {
    const shown = ['a', 'b', 'c', 'd']
    expect(moveProjects([], shown, ['d'], 'a', 'before')).toEqual(['d', 'a', 'b', 'c'])
    expect(moveProjects([], shown, ['a'], 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveProjects([], shown, ['d', 'a'], 'b', 'after')).toEqual(['b', 'a', 'd', 'c'])
  })

  it('看不到的项目（别的机器的）接在后面，相对先后不变；拖到自己身上不变', () => {
    expect(moveProjects(['x', 'a', 'y', 'b'], ['a', 'b'], ['b'], 'a', 'before')).toEqual(['b', 'a', 'x', 'y'])
    expect(moveProjects([], ['a', 'b'], ['a', 'b'], 'b', 'after')).toEqual(['a', 'b'])
  })

  it('放到分区里的项目旁边就进这个分区，放到外面的项目旁边就移出分区', () => {
    const state = { groups, order: [] }
    const shown = ['b', 'd', 'a', 'c', 'e']
    expect(dropProjects(state, shown, ['a'], 'd', 'before')).toEqual({
      groups: [{ ...groups[0], projects: ['d', 'b', 'a'] }, groups[1]],
      order: ['b', 'a', 'd', 'c', 'e'],
    })
    expect(dropProjects(state, shown, ['b'], 'e', 'after')).toEqual({
      groups: [{ ...groups[0], projects: ['d'] }, groups[1]],
      order: ['d', 'a', 'c', 'e', 'b'],
    })
  })

  it('同一个分区里换位置：分区不变，只改先后', () => {
    const next = dropProjects({ groups, order: [] }, ['b', 'd', 'a'], ['d'], 'b', 'before')
    expect(next.order).toEqual(['d', 'b', 'a'])
    expect(next.groups.map(g => [...g.projects].sort())).toEqual([['b', 'd'], ['x']])
  })

  it('分区换位置；目标不存在或拖到自己身上不变', () => {
    const three = [...groups, { id: 'g3', name: '三', projects: ['c'] }]
    expect(moveGroup(three, 'g3', 'g1', 'before').map(g => g.id)).toEqual(['g3', 'g1', 'g2'])
    expect(moveGroup(three, 'g1', 'g2', 'after').map(g => g.id)).toEqual(['g2', 'g1', 'g3'])
    expect(moveGroup(three, 'g1', 'g1', 'after')).toEqual(three)
    expect(moveGroup(three, 'g1', 'nope', 'after')).toEqual(three)
  })
})

describe('Shift 连选', () => {
  const order = ['a', 'b', 'c', 'd']
  it('两头都算，方向不限', () => {
    expect(rangeBetween(order, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeBetween(order, 'd', 'a')).toEqual(order)
  })
  it('没有起点或起点不在列表里只选这一个', () => {
    expect(rangeBetween(order, null, 'c')).toEqual(['c'])
    expect(rangeBetween(order, 'zz', 'c')).toEqual(['c'])
    expect(rangeBetween(order, 'a', 'zz')).toEqual([])
  })
})
