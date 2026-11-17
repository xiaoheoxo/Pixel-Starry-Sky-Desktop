import { describe, expect, it } from 'vitest'
import { prChecksRequest } from '../../shared/types/session-status'
import type { GhResult, GhRunner } from './gh'
import { listChecks, mapGhPr } from './github'
import { mergeArgs, mergeOptions, mergePr } from './merge'

const URL = 'https://github.com/acme/web/pull/12'
const ok = (stdout = ''): GhResult => ({ code: 0, stdout, stderr: '', missing: false, timedOut: false })
const fake = (result: GhResult): GhRunner & { calls: string[][] } => {
  const calls: string[][] = []
  const run = (async (args: string[]) => {
    calls.push(args)
    return result
  }) as GhRunner & { calls: string[][] }
  run.calls = calls
  return run
}

describe('PR 的每项检查', () => {
  it('CheckRun 和 StatusContext 都认，没过的在前，链接只要 https', () => {
    const checks = listChecks([
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://x/1' },
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/2' },
      { __typename: 'StatusContext', context: 'ci/build', state: 'PENDING', targetUrl: 'javascript:alert(1)' },
      { name: '' },
    ])
    expect(checks).toEqual([
      { name: 'test', state: 'fail', url: 'https://x/2' },
      { name: 'ci/build', state: 'pending', url: '' },
      { name: 'lint', state: 'pass', url: 'https://x/1' },
    ])
    expect(listChecks(null)).toEqual([])
  })
  it('gh 的 PR 带上检查列表', () => {
    const pr = mapGhPr({
      number: 12,
      url: URL,
      state: 'OPEN',
      statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE', status: 'COMPLETED' }],
    })
    expect(pr?.checks).toEqual([{ name: 'test', state: 'fail', url: '' }])
  })
  it('「让 AI 修检查」的话列出失败项和链接，要求不要强推', () => {
    const text = prChecksRequest({
      url: URL,
      head: 'feat/a',
      checks: [
        { name: 'test', state: 'fail', url: 'https://x/2' },
        { name: 'lint', state: 'pass', url: '' },
      ],
    })
    expect(text).toContain('- test：https://x/2')
    expect(text).not.toContain('lint')
    expect(text).toContain('推送到 feat/a（不要强推）')
  })
})

describe('合并', () => {
  it('合并方式只列仓库允许的，按网页的顺序', async () => {
    const gh = fake(
      ok(JSON.stringify({ mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true })),
    )
    expect(await mergeOptions(gh, URL)).toEqual({ methods: ['squash', 'rebase'], deleteBranch: true })
    expect(gh.calls[0]).toEqual([
      'repo',
      'view',
      'acme/web',
      '--json',
      'mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge',
    ])
  })
  it('一个都没读到时只给合并提交', async () => {
    expect((await mergeOptions(fake(ok('{}')), URL)).methods).toEqual(['merge'])
  })
  it('gh pr merge 的参数：方式、删远端分支', async () => {
    expect(mergeArgs(URL, 'squash', true)).toEqual(['pr', 'merge', URL, '--squash', '--delete-branch'])
    const gh = fake(ok())
    await mergePr(gh, URL, 'rebase', false)
    expect(gh.calls[0]).toEqual(['pr', 'merge', URL, '--rebase'])
  })
  it('不是 PR 地址、方式不对时不跑 gh', async () => {
    const gh = fake(ok())
    await expect(mergePr(gh, 'https://evil.example/pull/1', 'merge', true)).rejects.toThrow('不是 GitHub 的 PR 地址')
    await expect(mergePr(gh, URL, '--admin', true)).rejects.toThrow('合并方式不正确')
    expect(gh.calls).toEqual([])
  })
  it('失败时把 gh 的原话给用户；没登录、没装另有提示', async () => {
    const fail = (stderr: string, patch: Partial<GhResult> = {}) =>
      fake({ code: 1, stdout: '', stderr, missing: false, timedOut: false, ...patch })
    await expect(
      mergePr(fail('Pull request is not mergeable: base branch policy'), URL, 'merge', true),
    ).rejects.toThrow('base branch policy')
    await expect(mergePr(fail('run gh auth login'), URL, 'merge', true)).rejects.toThrow('gh auth login')
    await expect(mergePr(fail('', { missing: true, code: null }), URL, 'merge', true)).rejects.toThrow('没找到 gh')
  })
})
