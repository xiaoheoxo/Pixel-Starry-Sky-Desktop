# C / C++ 支持

C 和 C++ 项目的代码片段、CMake / Meson 任务、写测试和排查构建问题的技能与提示词，并带一套可选的语法高亮。

## 装上以后

- **代码片段**：在 `.c` / `.h`（语言 C）和 `.cpp` / `.hpp` 等（语言 C++）里输入前缀后补全。注意 `.h` 按 C 处理。

  C（15 条）：

  | 前缀 | 作用 |
  | --- | --- |
  | `main` / `mainargs` | main 函数（无参数 / 带 argc、argv） |
  | `once` | `#ifndef` 头文件保护 |
  | `externc` | 供 C++ 包含的 `extern "C"` 包裹 |
  | `struct` / `tdstruct` / `enum` | 结构体、typedef 结构体、typedef 枚举 |
  | `malloc` / `free` | 分配并检查返回值 / 释放后置空 |
  | `for` / `switch` | size_t 下标循环 / 带 default 的 switch |
  | `fopen` | 打开文件，失败用 perror 报错，结尾 fclose |
  | `funcptr` / `defmacro` / `inc` | 函数指针类型、多行宏、常用系统头文件 |

  C++（25 条）：

  | 前缀 | 作用 |
  | --- | --- |
  | `main` / `mainargs` | main 函数（无参数 / 参数收进 vector） |
  | `once` / `inc` | `#pragma once` / 常用标准头文件 |
  | `class` / `struct` / `iface` / `rule5` | 零法则的类、聚合类型、带虚析构的接口、特殊成员函数 |
  | `ns` / `nsanon` / `enumc` | 命名空间、匿名命名空间、enum class |
  | `uptr` / `sptr` | make_unique / make_shared |
  | `rfor` / `fori` / `lambda` | 范围 for、下标 for、lambda |
  | `opt` / `sbind` / `ifinit` | optional、结构化绑定、带初始化的 if |
  | `tmpl` / `concept` | 函数模板、C++20 concept |
  | `try` / `fmt` | try / catch、std::format 输出 |
  | `gtest` / `catch2` | GoogleTest / Catch2 v3 测试用例（项目里要有对应的库） |

- **任务**：「任务」视图认识下面几种文件。
  - `CMakeLists.txt`（内容里有 `project(` 的才列，即顶层文件）：`configure`（`cmake -S . -B build`）、`build`（`cmake --build build`）、`test`（`ctest --test-dir build --output-on-failure`）。三个任务各自成一组，分别叫「CMake 配置」「CMake 构建」「CMake 测试」。
  - `CMakePresets.json` / `CMakeUserPresets.json`：从 `configurePresets` 取名字，运行 `cmake --preset <名字>`；从 `buildPresets` 取名字，运行 `cmake --build --preset <名字>`；从 `testPresets` 取名字，运行 `ctest --preset <名字>`。
  - `meson.build`（内容里有 `project(` 的）：`setup`（`meson setup builddir`）、`compile`（`meson compile -C builddir`）、`test`（`meson test -C builddir`）。
  - 项目自带的 `Makefile` 由软件内置的 make 任务处理，不在这里。
- **技能**：`cpp-project`，Claude Code 里是 `/ext-pixelsky-cpp:cpp-project`，Codex 里是 `$cpp-project`。教 AI 先认项目的构建系统和依赖，用项目自己的工具，改完按构建、测试、格式化、clang-tidy、消毒器的顺序验证，并列出常见的链接和构建坑。
- **提示词**：输入框「/」菜单和编辑器右键里有：
  - 为选中代码写单元测试（沿用项目已有的测试框架）
  - 审查内存和资源安全（选中代码）
  - 解释编译 / 链接报错（只在输入框）
  - 改写成现代 C++（选中代码）
- **语法高亮**：带 C 和 C++ 两套 TextMate 语法。**软件已内置高亮的 `.c` `.h` `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx` 默认仍用内置的；想换成这套，在扩展详情里打开「用这个扩展代替内置高亮」。内置高亮支持代码折叠，扩展语法没有。`.c++` `.h++` `.ipp` `.inl` `.tpp` 软件本来不认识，装上扩展后直接用这套语法，不需要开关，也没有折叠。

## 已知问题

- 预设任务靠正则从 JSON 文本里取名字，有几点局限：`"hidden": true` 的隐藏预设会被跳过，但 `name` 和 `hidden` 之间隔着嵌套对象时跳不掉，仍会列出来（运行会报错）；`testPresets` 的 `filter` 里写了形如 `"name": "foo"` 的条件时，可能被当成预设名列出来；名字里有空格或其他特殊字符的预设不会列出（任务名不能含空格），请在终端里用 `cmake --preset "名字"` 运行。
- CMake 的 `test` 任务（`ctest --test-dir`）和所有预设任务（`--preset`）需要 CMake 3.20 或更新；系统自带的 CMake 太旧（例如 Ubuntu 20.04 的 3.16）时会报参数不认识。
- CMake 的 `project(` 判断认 `project(`、`PROJECT(`、`Project(`、`project (`、`PROJECT (` 几种写法，其他大小写或空白写法不会列出任务。
- Meson 任务靠内容里有 `project(` 来判断顶层文件，子目录的 `meson.build` 里若调用了 `subproject(` 也会被列出，但那里运行 `meson setup builddir` 会失败，请忽略。
- CMake 的 `test` 任务在项目没有调用 `enable_testing()` / `include(CTest)` 时也会列出，运行会提示没有测试。
- 任务固定使用 `build`（CMake）和 `builddir`（Meson）作为构建目录，且不能带参数；需要别的目录、构建类型或多配置生成器的 `--config` 时，请用预设或自己在终端里运行。
- 软件的文件搜索会跳过名为 `build` 的文件夹，所以放在 `build/` 里的文件不会被搜到。
- C++ 的 `.h` 头文件按 C 处理，里面的 C++ 写法可能高亮不全。

## 来源和许可证

扩展本身以 MIT 许可发布。语法文件来自 [microsoft/vscode](https://github.com/microsoft/vscode) 的 `extensions/cpp`，由 [jeff-hykin/better-cpp-syntax](https://github.com/jeff-hykin/better-cpp-syntax)（C++）和 [jeff-hykin/better-c-syntax](https://github.com/jeff-hykin/better-c-syntax)（C）生成，MIT 许可；它们最初派生自 atom/language-c 和 TextMate 的 C bundle。具体提交号见 `SOURCE.md`，上游版权声明和许可证全文附在 `LICENSE` 末尾。片段、技能、提示词、示例是本扩展原创。
