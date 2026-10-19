请把下面这段 {{language}} 代码改写得更现代、更安全，代码来自文件 {{file}}：

{{selection}}

在不改变外部行为和公开接口的前提下：
1. 手写的 new / delete、malloc / free、fopen / fclose 改成 RAII（std::unique_ptr、std::vector、std::string、std::fstream 或自定义的小型 RAII 类）。
2. 原始指针加长度改成 std::span / std::string_view；能用标准算法和范围 for 的循环就改掉。
3. 适合的地方加上 const、constexpr、noexcept、[[nodiscard]] 和 override，对没有暴露给外部的枚举，用 enum class 代替裸枚举（公开头文件里的枚举保持原样）。
4. 先确认项目使用的 C++ 标准（看 CMAKE_CXX_STANDARD、target_compile_features 或 -std= 选项），只用该标准里有的特性，不要擅自升级标准。
5. 如果这是纯 C 代码，或者头文件还要被 C 代码引用，就不要改成 C++ 写法，并告诉我原因。

改完逐点说明改了什么、为什么行为不变，并告诉我应该跑哪些现有测试来验证。
