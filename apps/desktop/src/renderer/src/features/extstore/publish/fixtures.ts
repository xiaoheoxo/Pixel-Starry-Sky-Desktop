import type {
  ExtPackIssue,
  ExtStoreCheckReport,
  ExtStoreMyExtension,
  ExtStoreMyVersion,
  ExtStorePickUploadResult,
  ExtStorePublisherState,
} from '@pixelsky/protocol'

// 「我的发布」测试共用的数据

export const version = (over: Partial<ExtStoreMyVersion> = {}): ExtStoreMyVersion => ({
  version: '1.0.0',
  status: 'approved',
  sha256: 'a'.repeat(64),
  size: 1000,
  hints: 0,
  rulesVersion: 2,
  toolVersion: '1',
  blocked: false,
  blockReason: '',
  submittedAt: null,
  reviewedAt: null,
  rejectReason: null,
  ...over,
})

export const extension = (over: Partial<ExtStoreMyExtension> = {}): ExtStoreMyExtension => ({
  id: 'lin.swift-support',
  name: 'Swift Support',
  description: '',
  kinds: ['grammars'],
  latestVersion: '1.2.0',
  downloads: 1284,
  installs: 10,
  delisted: false,
  delistedBy: '',
  delistReason: '',
  blocked: false,
  blockReason: '',
  createdAt: null,
  updatedAt: null,
  versions: [version({ version: '1.2.0' })],
  ...over,
})

export const publisherState = (extensions: ExtStoreMyExtension[], name = 'lin'): ExtStorePublisherState => ({
  publisher: { name, official: false, createdAt: null },
  extensions,
})

export const issue = (over: Partial<ExtPackIssue> & { zh: string }): ExtPackIssue => {
  const { zh, ...rest } = over
  return { severity: 'warning', scope: 'pack', code: 'x.y', message: { zh, en: zh }, ...rest }
}

export const report = (issues: ExtPackIssue[] = [], over: Partial<ExtStoreCheckReport> = {}): ExtStoreCheckReport => ({
  incomplete: false,
  issues,
  ...over,
})

export const picked = (over: Partial<ExtStorePickUploadResult> = {}): ExtStorePickUploadResult => ({
  token: 't1',
  id: 'lin.swift-support',
  version: '1.3.0',
  report: report(),
  contributes: null,
  previousContributes: null,
  checks: { permissions: [], prefixOk: true, versionNewer: true },
  ...over,
})
