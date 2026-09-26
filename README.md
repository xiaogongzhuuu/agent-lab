# Agent Trace Lab

一个用于学习 Tool Calling 和 ReAct 循环的交互实验台。页面展示模型请求、`tool_call`、工具执行结果（Observation）以及下一轮上下文。

## 运行方式

- **自动运行**：连续完成模型决策、工具调用和结果汇总。
- **分步确认**：依次检查模型输入、DeepSeek 返回的工具调用和工具执行结果，再决定是否继续。

左侧的“实验一”可以切换工具描述与顺序，观察同一个问题下模型选择的工具。页面展示可观察的请求与响应；模型内部的隐藏思维过程不在 API 返回值中。

## 本地启动

需要 Node.js 22.13 或更高版本，以及一个 DeepSeek API Key。

```bash
npm ci
```

在项目根目录创建不纳入 Git 的 `.env.local`：

```text
DEEPSEEK_API_KEY=你的密钥
```

然后运行：

```bash
npm run dev
```

打开 [http://localhost:5173/](http://localhost:5173/)。

## 开发命令

```bash
npm run format        # 整理 app/ 和 lib/ 下的代码
npm run format:check  # 检查格式
npm run build         # 构建项目
```

工具选择和调用参数由 DeepSeek 生成。`search_solutions`、`analyze_reviews` 和 `compare_pricing` 的执行结果来自项目内的演示数据，不是实时联网检索或最新价格。
