---
name: go-project
description: 在 Go 项目里写代码、跑测试、修编译和 vet 报错、整理依赖时使用（看到 go.mod、go.work、*.go 就用）。Use when working in a Go project: building, testing, vetting, linting, managing modules, or fixing compiler errors.
---

# Go 项目工作约定

## 先认清项目，再动手

1. 看根目录和子目录的 `go.mod`（module 路径、`go` 行的版本、`toolchain` 行、`replace`）。有 `go.work` 说明是多模块工作区，命令要在对应模块目录里跑，或用 `-C 目录`。
2. 找项目自己的入口：`Makefile`、`Taskfile.yml`、`magefile.go`、`justfile`、CI 配置（`.github/workflows`）。里面已有 build / test / lint 命令时，**照着它们跑**，不要另起一套。
3. 看有没有 `.golangci.yml` / `.golangci.yaml` / `.golangci.toml`（lint 配置）、`vendor/` 目录（有就说明依赖已入库，构建默认带 `-mod=vendor`）、`//go:generate` 指令和 `tools.go`。
4. 代码风格以现有代码为准；没有额外约定就用 `gofmt` 的结果。

## 验证改动（按这个顺序）

```bash
go build ./...          # 先保证能编译
go vet ./...            # 官方静态检查
go test ./...           # 全部测试
go test -run '^TestName$' ./path/to/pkg   # 只跑某个测试
go test -race ./...     # 改了并发代码时加 -race（需要 cgo，Windows 上需要 gcc）
golangci-lint run ./... # 仅当项目有 golangci 配置、且本机装了 golangci-lint
```

- 格式化用 `gofmt -l .` 看哪些文件没格式化，`gofmt -w 文件` 或 `go fmt ./...` 修正；项目用 `goimports` / `gofumpt` 就用它们。
- 测试结果可能被缓存，需要重新跑时加 `-count=1`；看详细输出加 `-v`；只想看某个包就指定包路径，不要无谓地跑全仓库。
- 改了 `//go:generate` 相关的源文件（protobuf、mock、stringer 等），先看项目怎么生成，再运行 `go generate ./...`，不要手改生成出来的文件。

## 依赖和模块

- 加依赖用 `go get 模块路径@版本`，**先问用户**，能用标准库解决就不要加。项目没有的第三方库（testify、zap、cobra…）不要擅自引入。
- 改完 import 或依赖后运行 `go mod tidy`，并确认 `go.mod`、`go.sum` 的改动只与本次需求有关。有 `vendor/` 的项目还要 `go mod vendor`。
- `go.work` 工作区里要小心：`go mod tidy` 不看 `go.work`。如果某个模块依赖同一工作区里尚未发布的兄弟模块、又没有 `replace`，tidy 会去网上拉取并失败。这时不要自己加 `replace`，先问用户：是先发布兄弟模块，还是由用户同意加 `replace`。
- 不要擅自升高 `go.mod` 里的 `go` 版本，也不要随手升级依赖；新语法（泛型、`for range 整数`、`slices` / `maps` 包、`b.Loop()`）先确认项目的 Go 版本够用。
- 不要用 `replace` 或 `GOFLAGS=-mod=mod` 绕过报错，除非用户明确要求。

## 常见坑

- 错误：不要忽略；向上返回时用 `fmt.Errorf("动作: %w", err)` 保留链，判断用 `errors.Is` / `errors.As`，不要比较字符串。
- `defer` 在循环里会拖到函数返回才执行；`defer` 的参数在声明时就求值。
- 接口里装了值为 nil 的指针，接口本身不等于 nil；返回错误时直接 `return nil`，不要返回类型化的 nil 指针。
- goroutine 必须有结束的办法（`context`、关闭通道、`WaitGroup`）；通道由发送方关闭；map 并发读写要加锁或用 `sync.Map`。
- Go 1.22 起 `for` 循环变量每轮独立；`go.mod` 版本更低时闭包里要拷贝循环变量。
- 切片 `append` 可能共享底层数组；对外返回内部切片或 map 前先想清楚是否要拷贝。
- 表驱动测试用 `t.Run` 起子测试；测试辅助函数调用 `t.Helper()`；临时文件用 `t.TempDir()`，环境变量用 `t.Setenv`。
- 导入循环、`internal` 包可见性、构建标签（`//go:build`）和 `_test` 后缀包是常见的编译错误来源，报错时先排查这些。
- 报错信息要看完整：编译器通常在第一条错误之后的错误是连带的，先修第一条再重新编译。

## 做完后

说明跑了哪些命令、结果如何；没跑的（比如没装 golangci-lint、缺 cgo）要如实说，不要声称已通过。
