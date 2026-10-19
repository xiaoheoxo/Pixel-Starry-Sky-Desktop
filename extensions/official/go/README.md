# Go 支持

Go 项目的常用代码片段、`go build / test / vet / mod` 和 golangci-lint 任务，以及写测试、修报错的技能和提示词。

## 装上以后

- **代码片段**（语言 `go`）：

| 前缀 | 作用 |
| --- | --- |
| `main` / `mainfile` | main 函数 / 整个文件，main 只管退出码、逻辑放进 `run() error` |
| `initfn` `func` `meth` `newfn` | init 函数 / 函数 / 方法 / New 构造函数 |
| `struct` `iface` `enum` | 结构体 / 接口 / iota 枚举 |
| `iferr` `errwrap` `errvar` `errtype` | `if err != nil` / 用 `%w` 包装 / 哨兵错误 / 带 `Unwrap` 的错误类型 |
| `erris` `erras` | `errors.Is` / `errors.As` |
| `forr` `fori` `switch` `tswitch` `select` | 循环、switch、类型 switch、带 `ctx.Done()` 的 select |
| `ctxtimeout` `ctxcancel` | `context.WithTimeout` / `WithCancel` 并 defer cancel |
| `gowg` `errgroup` `mutex` | goroutine 加 WaitGroup / errgroup / 加锁并 defer 解锁 |
| `deferclose` `openfile` | defer 关闭 / 打开文件 |
| `handler` `httpserver` `jsonstruct` `jsonresp` | HTTP 处理函数 / 带超时的 `http.Server` / json 标签结构体 / 写 JSON 响应 |
| `test` `tdt` `trun` `thelper` `bench` `fuzz` | 测试 / 表驱动测试 / 子测试 / 测试辅助函数 / 基准测试 / 模糊测试 |

片段不会自动补 import，展开后按需要加上。

- **任务**：「任务」视图里认 `go.mod` 和 `go.work`。

| 来源 | 任务 | 命令 |
| --- | --- | --- |
| `go.mod` | build / test / vet / fmt / generate | `go build ./...`（其余同理） |
| `go.mod` | tidy / download / verify | `go mod tidy`（其余同理） |
| `go.mod` | run（同目录有 `main.go` 时） | `go run .` |
| `go.mod` | lint（同目录有 `.golangci.yml` 或 `.golangci.yaml` 时） | `golangci-lint run ./...` |
| `go.work` | sync | `go work sync` |

  任务在 `go.mod` 所在的文件夹里运行，所以多模块项目里每个模块各有一组。

- **技能**：`go-project`，Claude Code 里是 `/ext-pixelsky-go:go-project`，Codex 里是 `$go-project`。教 AI 先认项目的 `go.mod` / `go.work` / Makefile / CI，再按 build、vet、test、lint 的顺序验证，不擅自加依赖或升级 Go 版本。
- **提示词**：输入框「/」菜单和编辑器右键里有「为选中代码写表驱动测试」「解释这段 Go 代码」「改进选中代码的错误处理」；输入框「/」菜单里另有「解释编译或 vet 报错」。

## 已知问题

- 只认 `go.mod` 同目录下的 `main.go` 来列 `run` 任务；入口在 `cmd/xxx/main.go` 的项目不会出现 `run`，请自己在终端里运行 `go run ./cmd/xxx`。
- golangci-lint 只认 `.golangci.yml` 和 `.golangci.yaml`，`.toml` / `.json` 配置的项目不会出现 lint 任务；两个文件同时存在时会出现两组。
- `go mod tidy` 不看 `go.work`：工作区里的模块若依赖尚未发布的兄弟模块且没有 `replace`，tidy 任务会因为拉不到该模块而失败，需要先发布该模块或自行加 `replace`。
- lint 任务只在配置文件与 `go.mod` 在同一目录时出现；配置放在上级目录（多模块仓库共用根目录配置）时不会识别，请在这些模块里自己运行 `golangci-lint run ./...`。
- `bench` 片段用的 `b.Loop()` 需要 Go 1.24 及以上；`gowg` 片段依赖 Go 1.22 起每轮循环变量独立的行为；`httpserver` 里 `"GET /health"` 的路由写法需要 Go 1.22 及以上。
- `go fmt`、`go generate` 任务会改动文件，运行前请确认。

## 来源和许可证

片段、技能、提示词和任务模板均为本扩展自写，以 MIT 许可证发布，全文见 `LICENSE`。
