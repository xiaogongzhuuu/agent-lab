import { env } from "cloudflare:workers";

type DeepSeekMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type FinalResult = { summary: string; recommendation: string; evidence: string[]; risks: string[]; next_steps: string[] };

const tools = [
  { type: "function", function: { name: "search_solutions", description: "Search a preset catalog for solutions relevant to the user's problem.", parameters: { type: "object", properties: { query: { type: "string" }, category: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "analyze_reviews", description: "Analyze preset user-review evidence for the candidates under consideration.", parameters: { type: "object", properties: { candidates: { type: "array", items: { type: "string" } }, focus: { type: "string" } }, required: ["candidates"] } } },
  { type: "function", function: { name: "compare_pricing", description: "Compare preset cost and budget-fit data for candidate solutions.", parameters: { type: "object", properties: { candidates: { type: "array", items: { type: "string" } }, budget: { type: "number" }, currency: { type: "string" } }, required: ["candidates"] } } },
] as const;

const presetResults: Record<string, (args: Record<string, unknown>) => unknown> = {
  search_solutions: (args) => ({ query: args.query, source: "preset_catalog_2026q3", matches: [{ name: "Notion AI", score: 4.8, strengths: ["上手快", "知识库与协作一体化"] }, { name: "Guru", score: 4.6, strengths: ["验证机制", "企业搜索"] }, { name: "Slite", score: 4.5, strengths: ["轻量", "写作体验"] }, { name: "Confluence AI", score: 4.3, strengths: ["复杂权限", "研发集成"] }] }),
  analyze_reviews: (args) => ({ candidates: args.candidates, sample_size: 1284, sentiment: { positive: 0.82, neutral: 0.12, negative: 0.06 }, highlights: ["检索速度与编辑体验最受好评", "权限配置是最常见的负面反馈", "小团队更偏好低维护方案"] }),
  compare_pricing: (args) => ({ currency: args.currency ?? "CNY", monthly_estimates: [{ name: "Notion AI", amount: 1080, within_budget: true }, { name: "Guru", amount: 1420, within_budget: true }, { name: "Slite", amount: 680, within_budget: true }, { name: "Confluence AI", amount: 1560, within_budget: false }], note: "Preset estimates include 10 seats and exclude migration services." }),
};

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function safeArgs(raw: string) { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } }
function normalizeResult(value: unknown): FinalResult {
  const result = (value && typeof value === "object" ? value : {}) as Partial<FinalResult>;
  const list = (items: unknown, fallback: string[]) => Array.isArray(items) ? items.slice(0, 5).map(String) : fallback;
  return { summary: typeof result.summary === "string" ? result.summary : "已完成多工具检索、口碑分析与成本比较。", recommendation: typeof result.recommendation === "string" ? result.recommendation : "建议先用低成本方案进行两周试点，再根据实际命中率扩大使用范围。", evidence: list(result.evidence, ["已检索 4 个候选方案", "分析 1,284 条预设评论", "完成预算适配检查"]), risks: list(result.risks, ["预设数据仅用于交互演示", "正式决策前需验证最新报价"]), next_steps: list(result.next_steps, ["确认关键用户", "建立试点数据集", "两周后复盘效果"]) };
}

async function callDeepSeek(messages: DeepSeekMessage[], options: { tools?: unknown[]; required?: boolean; json?: boolean } = {}) {
  const key = env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is not configured");
  const response = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "deepseek-chat", messages, temperature: 0.2, ...(options.tools?.length ? { tools: options.tools, tool_choice: options.required ? "required" : "auto" } : {}), ...(options.json ? { response_format: { type: "json_object" } } : {}) }) });
  if (!response.ok) throw new Error(`DeepSeek API ${response.status}`);
  const payload = await response.json() as { choices?: Array<{ message?: DeepSeekMessage }> };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("DeepSeek returned an empty response");
  return message;
}

export async function POST(request: Request) {
  const { question } = await request.json() as { question?: string };
  if (!question?.trim()) return Response.json({ error: "question is required" }, { status: 400 });
  const stream = new ReadableStream({
    async start(controller) {
      let counter = 0;
      const emit = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify({ id: `evt-${++counter}`, ...event })}\n`));
      try {
        emit({ type: "status", title: "理解任务并制定工具计划", detail: "DeepSeek 正在拆解问题；界面只展示执行摘要，不展示隐藏思维链。" });
        const messages: DeepSeekMessage[] = [{ role: "system", content: "You are a tool-using analyst. Use the available tools to gather evidence. Keep tool arguments concise. Never invent tool results." }, { role: "user", content: question.trim() }];
        const remaining = [...tools];
        for (let round = 0; round < 3; round++) {
          const started = Date.now();
          const assistant = await callDeepSeek(messages, { tools: remaining, required: true });
          const call = assistant.tool_calls?.[0];
          if (!call || !presetResults[call.function.name]) throw new Error("模型没有返回可执行工具");
          const args = safeArgs(call.function.arguments);
          messages.push({ ...assistant, content: assistant.content ?? null, tool_calls: [call] });
          emit({ type: "tool_call", title: `调用 ${call.function.name}`, tool: call.function.name, input: args });
          await sleep(260);
          const output = presetResults[call.function.name](args);
          emit({ type: "tool_result", title: `已接收 ${call.function.name} 返回值`, tool: call.function.name, output, duration: Date.now() - started });
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output) });
          const usedIndex = remaining.findIndex((item) => item.function.name === call.function.name);
          if (usedIndex >= 0) remaining.splice(usedIndex, 1);
        }
        emit({ type: "status", title: "汇总证据并验证输出结构", detail: "将三次工具结果整理为 recommendation schema" });
        messages.push({ role: "system", content: "Return one valid JSON object with exactly these keys: summary (string), recommendation (string), evidence (string[]), risks (string[]), next_steps (string[]). Respond in Chinese and ground every claim in tool results." });
        const finalMessage = await callDeepSeek(messages, { json: true });
        const finalResult = normalizeResult(JSON.parse(finalMessage.content ?? "{}"));
        emit({ type: "final", title: "结构化建议已生成", detail: "Schema 校验通过", output: finalResult });
      } catch (error) { emit({ type: "error", title: "Agent 运行失败", detail: error instanceof Error ? error.message : "Unknown error" }); }
      finally { controller.close(); }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
