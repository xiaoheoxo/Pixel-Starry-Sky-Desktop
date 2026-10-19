# 扩展包共享用例（corpus）

同一批用例，被所有实现各跑一遍，结果必须一致：

| 跑法 | 在哪 | 比较什么 |
| --- | --- | --- |
| A 内存来源 | `packages/extension-cli/test/corpus.test.ts` | 文件夹用例：`checkPack(内存来源)`，开发级别对 `dev`，上传级别（语法引擎 off 的用例）对 `upload`；zip 用例：`checkPack(readPackZip(…))` 对 `upload` |
| B 文件夹 | 同上 | 写到 `scratch/` 下的真文件夹，走 `checkInput`，`dev` 和 `upload` 都比 |
| C zip | 同上 | 文件夹用例打成 zip（`writePackZip`）、zip 用例直接用，走 `checkInput`，比 `upload` |
| D 桌面 | `apps/desktop/src/main/extension-packs/parity.test.ts` | 文件夹用例写成真文件夹，`loadPack` 的结果对 `dev` |
| E Go（以后） | `services/cloud/internal/extensions/*_test.go` | `grammar` 为 `off` 的用例，结果对 `upload` |

## 目录

```
bases/<名字>/          真实的扩展文件夹（纯文本，LF 换行），用例在它上面改
cases/<NNN-名字>.json  用例（手写；这里的脚本辅助生成也行，但提交的是 JSON）
cases/<NNN-名字>.expect.json  期望（用 CORPUS_UPDATE=1 生成，逐条核对后提交）
```

编号按族排，方便排序：`0xx` 正例和略过列表，`1xx` 清单，`2xx` 文件，`3xx` 语法，`4xx` 主题，`5xx` 片段，`6xx` 图标，`7xx` 任务模板，`8xx` 技能和提示词，`9xx` zip。

底板：

- `pixelsky.dotenv`：作者示例（和 `docs/extensions/examples/pixelsky.dotenv` 逐字节一致，docs 在本机时测试会比对）。
- `all-kinds`：七种贡献各一条，全部合格。语法检查没跑时（开发级别、`--grammar off`）只有一条「语法正则没检查」的提示；`003-all-kinds-full` 用完整检查，上传级别没有任何问题。
- `bad-manifest`、`unsafe-svg`、`with-skill`、`with-tasks`：从桌面的 `__fixtures__` 搬来。后两个没有 README 和 LICENSE，所以有 `files.readme` / `files.license`。

## 用例 JSON

```json
{
  "title": "清单是符号链接：当作没有清单",
  "expectCodes": ["manifest.missing"],
  "base": "pixelsky.dotenv",
  "input": "folder",
  "grammar": "off",
  "appVersion": "0.4.1-beta",
  "remove": ["README.md"],
  "files": {
    "pixelsky-extension.json": { "merge": { "icon": null } },
    "themes/t.json": { "json": { "name": "x" } },
    "a.md": "plain UTF-8 text",
    "bom.json": { "base64": "77u/e30=" },
    "big.txt": { "repeat": "x", "bytes": 2097153 },
    "link": { "symlink": "README.md" }
  },
  "generate": [{ "path": "extra/f{i}.txt", "count": 501, "text": "x" }],
  "zipEntries": [{ "name": "../evil.txt", "text": "x" }],
  "zipOptions": { "eocd": { "disk": 1 } },
  "zipBase64": null,
  "needs": ["symlink"]
}
```

- `expectCodes`：作者的意图。测试断言这些代码确实出现在期望里（`dev` 或 `upload`），防止生成的期望把 bug 固化下来。`expectCodes` 是空数组的文件夹用例，上传级别必须一个问题都没有。
- `input`：`folder`（默认意义上的文件夹）或 `zip`。`grammar`：上传级别的语法引擎模式 `off`（默认，Go 也能跑）、`regex`、`full`。
- 文件树：底板 → `remove`（文件或文件夹）→ `files` → `generate`。`merge` 深合并进底板里的 JSON（`null` 删键，数组整体替换），`json` 整个替换。文件夹用例会套用略过列表，zip 用例不套用（zip 里有什么就是什么）。
- `files` 里值的写法：字符串（UTF-8）、`{ base64 }`、`{ json }`、`{ merge }`、`{ repeat, bytes }`（重复到指定字节数）、`{ symlink }`。
- `input: "zip"`：
  - 没有 `zipEntries` / `zipOptions` / `zipBase64`：把文件树用 `writePackZip` 打包。
  - `zipEntries`：文件树 + 这些手写条目，用测试专用的手写 zip 写入器（`packages/extension-cli/src/testing/raw-zip.ts`）。条目可以写 `name` 或 `nameBase64`（原始字节）、`text` / `base64` / `repeat` + `bytes` / `symlink` / `dir`，以及 `encrypted`、`method`、`badCrc`、`badSize`、`noUtf8Flag`。
  - `zipOptions`：覆盖 EOCD 字段（`disk`、`cdDisk`、`count`、`countHere`、`cdSize`、`cdOffset`）或 `noEocd`。
  - `zipBase64`：原样使用。
- `needs: ["symlink"]`：要创建符号链接。这台机器建不了时，B 跑法跳过（A 和 C 仍然覆盖；C 本身也跳过带符号链接的文件夹用例）。
- 文件夹用例读不全（超过扫描上限）时，C 跑法跳过：打成 zip 后条目数就不一样了。

## 期望 JSON

```json
{
  "rulesVersion": 2,
  "dev": { "status": "warning", "inactive": {}, "skills": [{ "name": "review", "index": 0 }], "issues": [] },
  "upload": { "pass": false, "issues": [] }
}
```

- 归一化后的问题：`{ code, severity, scope, path?, contribution?, upload?, pointer?, outcome? }`。**不比较文字，也不比较行列**；`pointer` 是 `loc.pointer`；`outcome` 只在 `upload` 里有（`reject` / `hint` / `note`）。按 JSON 串排序，当多重集比较。
- `dev` 用 `appVersion`（默认 `0.4.1-beta`），zip 用例没有 `dev`。`upload` 的 `pass` 是 `checkVerdict(issues, { level: 'upload' })`，没有 `--strict`。
- 开发级别的文件夹来源没有语法引擎，所以带语法的用例在 `dev` 里都有 `grammar.regexUnchecked`；上传级别用 `--grammar off` 时同理，`full` / `regex` 时没有（`regex` 多一条 `grammar.perfUnchecked`）。

## 豁免

下面这些代码没有用例（测试里有同样的常量）：

| 代码 | 原因 |
| --- | --- |
| `pack.duplicateId` | 只有多个扩展并存时，服务才会产生 |
| `pack.storeBlocked` | 只有停用名单命中文件夹扩展时，服务才会产生 |
| `pack.validate`、`validate.internal` | 校验器自己崩溃的兜底，没有输入能触发 |
| `grammar.hang`、`grammar.slowLine`、`grammar.slowTotal`、`grammar.perfNearLimit` | 和机器速度有关；由 `grammar.test.ts`（注入时钟）和 `bundle.test.ts`（卡死）覆盖 |

`grammar.load` 有确定的触发方式：语法文件的 `patterns` 写成字符串（`326`）。

## 怎么用、怎么改

- 重新生成期望：`CORPUS_UPDATE=1 pnpm --filter @pixelsky/extension-cli exec vitest run test/corpus.test.ts`。**生成后必须逐个读 `.expect.json` 对照用例的 `title` / `expectCodes`**，不要直接接受；只在 `git diff` 里看每处变化是不是有意的。`check.mjs` 里不要设这个变量。
- 规则语义变了就把 `EXT_RULES_VERSION` 加一，并在 `cases/` 里补对应的用例。新增问题代码时要同时加一个用例（否则覆盖测试会失败）。
- Go 端（以后）读 `cases/*.json` 和 `bases/`，按上面的规则物化文件树，跑 `grammar` 为 `off` 的用例，对 `upload`。Go 要自己实现的只有：文件树物化、zip 条目构造（可以直接用 `zipBase64`，需要时让 TS 端把 zip 导出来）、归一化和多重集比较。
