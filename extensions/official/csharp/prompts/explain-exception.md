下面是 {{project}} 里出现的 C# 异常或堆栈，请帮我分析。

我会把异常信息和堆栈贴在这条消息的末尾（没贴的话请先让我贴）。

要求：
1. 先用一两句话说明这个异常是什么意思、通常是什么原因造成的（比如 NullReferenceException、InvalidOperationException、TaskCanceledException、DbUpdateException 的内层异常要往下看 InnerException）。
2. 在堆栈里找出第一个属于本项目代码的帧，打开对应文件和行号，结合代码说明这一处具体为什么会出错。
3. 给出最小的修复方案，并说明怎么复现或用测试验证；不要为了让异常消失而吞掉它。
4. 如果信息不足以确定原因，列出还需要的信息（输入数据、配置、环境），不要猜。
