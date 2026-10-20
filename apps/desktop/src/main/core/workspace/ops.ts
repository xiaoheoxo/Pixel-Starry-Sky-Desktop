// 项目文件读写（docs/ui/open-in-editor.md）：本机与远端共用的操作表。显示文件夹、复制路径只在本机（workspace/files-ipc.ts）
import type { OpTable } from '../ops'
import { workspaceRef, type WorkspaceFiles } from '../workspace-files'

export interface FileOpContext {
  files: WorkspaceFiles
}

export const FILE_OPS = {
  'files:target': (c, ref) => c.files.target(ref),
  // 第三个参数 true：目录不存在时返回 null（listExisting）
  'files:list': (c, ref, path, missing) =>
    missing === true
      ? c.files.listExisting(workspaceRef(ref), path as string)
      : c.files.list(workspaceRef(ref), path as string),
  'files:search': (c, ref, name) => c.files.search(workspaceRef(ref), name as string),
  'files:status': (c, ref) => c.files.status(workspaceRef(ref)),
  'files:read': (c, ref, path) => c.files.read(workspaceRef(ref), path as string),
  'files:headContent': (c, ref, path) => c.files.headContent(workspaceRef(ref), path as string),
  'files:save': (c, ref, path, text, version) =>
    c.files.save(workspaceRef(ref), path as string, text as string, version as string),
  'files:stage': (c, ref, request) => c.files.stage(workspaceRef(ref), request),
  'files:grep': (c, ref, query) => c.files.grep(workspaceRef(ref), query),
  'files:create': (c, ref, path, kind) => c.files.create(workspaceRef(ref), path, kind),
  'files:rename': (c, ref, from, to) => c.files.rename(workspaceRef(ref), from, to),
  'files:remove': (c, ref, path) => c.files.remove(workspaceRef(ref), path),
} satisfies OpTable<FileOpContext>
