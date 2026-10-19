---
name: cpp-project
description: 在 C / C++ 项目里写代码、构建、跑测试、修编译和链接报错时使用。Use when working in a C or C++ project: building with CMake or Meson, running tests, fixing compiler or linker errors.
---

# C / C++ 项目工作约定

## 先认清项目用什么

动手前先看项目已有的东西，**用项目自己的工具，不擅自换构建系统、换编译器或加新依赖**：

- 构建系统：`CMakeLists.txt`（可能带 `CMakePresets.json` / `CMakeUserPresets.json`）、`meson.build`、`Makefile`、`configure.ac`、`BUILD.bazel`、`xmake.lua`。
- 依赖管理：`vcpkg.json`、`conanfile.txt` / `conanfile.py`、`FetchContent` / `find_package`、`subprojects/*.wrap`（Meson）、git submodule。依赖已经锁定（vcpkg 的 `builtin-baseline`、Conan 的 lockfile）就不要改版本。
- 语言标准和警告选项：看 `CMAKE_CXX_STANDARD`、`target_compile_features`、`-std=`、`-Wall -Wextra` 等；沿用，不擅自升标准、不关警告。
- 代码风格：`.clang-format`、`.clang-tidy`、`.editorconfig`；有就按它来。
- `.h` 既可能是 C 头文件也可能是 C++ 头文件，看项目里引用它的是哪种源文件。

## 构建和验证（按项目实际使用的工具选一套）

CMake（没有预设时）：

```
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

- 有 `CMakePresets.json` 就优先用预设：`cmake --list-presets` 列出，然后 `cmake --preset <名字>`、`cmake --build --preset <名字>`、`ctest --preset <名字>`。
- 单配置生成器（Makefile / Ninja）用 `-DCMAKE_BUILD_TYPE=Debug|Release` 选构建类型；多配置生成器（Visual Studio、Ninja Multi-Config）在构建和测试时用 `--config Debug` / `-C Debug`。
- 已有 `build/` 目录时直接复用，不要删掉重配；只有缓存明显坏了才重新配置，并先和用户说明。
- 只构建一个目标：`cmake --build build --target <目标>`；并行构建加 `-j`。
- 只跑部分测试：`ctest --test-dir build -R <正则> --output-on-failure`。

Meson：

```
meson setup builddir
meson compile -C builddir
meson test -C builddir
```

- 已配置的目录改选项用 `meson configure builddir -D<选项>=<值>`；需要重新配置用 `meson setup --reconfigure builddir`。

Makefile 项目：用 `make`、`make test`，以 Makefile 里实际有的目标为准（可先 `make -n` 看会执行什么）。

## 改完代码怎么确认

1. 构建通过，且没有新增警告（项目开了 `-Werror` 的更要注意）。
2. 先跑相关测试，再跑全部测试（`ctest` / `meson test`）。
3. 项目有格式化配置时，只格式化自己改过的文件：`clang-format -i <文件>`；不要整仓库重排。
4. 项目有 `clang-tidy` 配置时，对改动的文件跑一遍：`clang-tidy -p build <文件>`（需要 `build/compile_commands.json`，CMake 加 `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` 生成）。
5. 涉及内存、指针、并发的改动，用消毒器再验证一次，开在单独的构建目录里，不要污染默认目录：
   `cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug -DCMAKE_CXX_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer"`
   （C 项目把 `CMAKE_CXX_FLAGS` 换成 `CMAKE_C_FLAGS`；MSVC 用 `/fsanitize=address`；Meson 用 `-Db_sanitize=address,undefined`）。

## 写代码的习惯

- C++：优先 RAII 和标准库容器 / 智能指针，别手写 `new` / `delete`；成员都是 RAII 类型时不手写析构、拷贝和移动（rule of zero）；要写其中一个就把五个特殊成员函数想清楚（rule of five）。
- 多态基类要有虚析构函数；重写的函数写 `override`；单参数构造函数默认 `explicit`。
- 传参：只读且较大的对象用 `const T&`，只读字符串用 `std::string_view`，数组加长度用 `std::span`；不要返回指向局部变量的引用或指针。
- C：每次 `malloc` / `fopen` 都检查返回值；`sizeof(*p)` 比 `sizeof(Type)` 稳；释放后把指针置 `NULL`；字符串操作留意终止符和缓冲区长度，优先 `snprintf`，不用 `gets`、`strcpy`、`sprintf`。
- 头文件：C++ 用 `#pragma once` 或与项目一致的保护宏；头文件里不写 `using namespace`；被 C++ 引用的 C 头文件要有 `extern "C"` 包裹。
- 不要依赖未定义行为：有符号整数溢出、越界访问、未初始化读取、违反严格别名。

## 常见坑

- 链接报 `undefined reference`：先看是不是漏了 `target_link_libraries`、源文件没加进目标、声明和定义的签名不一致、或者静态库的顺序不对（被依赖的库要放后面）。
- 新增源文件后 CMake 没有感知：显式列出的源文件要手动加进 `add_executable` / `add_library`；用了 `file(GLOB)` 的需要重新运行配置。
- `find_package` 找不到：检查 `CMAKE_PREFIX_PATH`、vcpkg 的工具链文件（`-DCMAKE_TOOLCHAIN_FILE=...`）是否已在预设里配好，不要手工硬编码路径。
- Windows 上 MSVC 与 MinGW 的 ABI 不兼容，不要混用；`std::filesystem` 路径和宽字符问题要留意。
- 模板的长报错：从第一条 `error` 看起，后面的多半是连带的。
- 改了公开头文件，要确认依赖它的所有目标还能编译。
