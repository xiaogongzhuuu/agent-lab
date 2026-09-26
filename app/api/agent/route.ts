import { env } from "cloudflare:workers";
import {
  buildSelectionObservation,
  getExperimentalTools,
  normalizeExperimentVariant,
  type ToolExperimentVariant,
} from "@/lib/tool-experiment";

type DeepSeekMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type FinalResult = {
  summary: string;
  recommendation: string;
  evidence: string[];
  risks: string[];
  next_steps: string[];
};
type DecisionSummary = { goal: string; reason: string; evidence: string; next: string };

const presetResults: Record<string, (args: Record<string, unknown>) => unknown> = {
  search_solutions: (args) => ({
    query: args.query,
    source: "preset_catalog_2026q3",
    matches: [
      { name: "Notion AI", score: 4.8, strengths: ["上手快", "知识库与协作一体化"] },
      { name: "Guru", score: 4.6, strengths: ["验证机制", "企业搜索"] },
      { name: "Slite", score: 4.5, strengths: ["轻量", "写作体验"] },
      { name: "Confluence AI", score: 4.3, strengths: ["复杂权限", "研发集成"] },
    ],
  }),
  analyze_reviews: (args) => ({
    candidates: args.candidates,
    sample_size: 1284,
    sentiment: { positive: 0.82, neutral: 0.12, negative: 0.06 },
    highlights: [
      "检索速度与编辑体验最受好评",
      "权限配置是最常见的负面反馈",
      "小团队更偏好低维护方案",
    ],
  }),
  compare_pricing: (args) => ({
    currency: args.currency ?? "CNY",
    monthly_estimates: [
      { name: "Notion AI", amount: 1080, within_budget: true },
      { name: "Guru", amount: 1420, within_budget: true },
      { name: "Slite", amount: 680, within_budget: true },
      { name: "Confluence AI", amount: 1560, within_budget: false },
    ],
    note: "Preset estimates include 10 seats and exclude migration services.",
  }),
};

const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function safeArgs(raw: string) {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function safeJson(raw: string | null) {
  try {
    return JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
}
function normalizeResult(value: unknown): FinalResult {
  const result = (value && typeof value === "object" ? value : {}) as Partial<FinalResult>;
  const list = (items: unknown, fallback: string[]) =>
    Array.isArray(items) ? items.slice(0, 5).map(String) : fallback;
  return {
    summary:
      typeof result.summary === "string"
        ? result.summary
        : "已完成多工具检索、口碑分析与成本比较。",
    recommendation:
      typeof result.recommendation === "string"
        ? result.recommendation
        : "建议先用低成本方案进行两周试点，再根据实际命中率扩大使用范围。",
    evidence: list(result.evidence, [
      "已检索 4 个候选方案",
      "分析 1,284 条预设评论",
      "完成预算适配检查",
    ]),
    risks: list(result.risks, ["预设数据仅用于交互演示", "正式决策前需验证最新报价"]),
    next_steps: list(result.next_steps, ["确认关键用户", "建立试点数据集", "两周后复盘效果"]),
  };
}

async function callDeepSeek(
  messages: DeepSeekMessage[],
  options: { tools?: unknown[]; required?: boolean; json?: boolean } = {},
) {
  const key = env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is not configured");
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      temperature: 0.2,
      ...(options.tools?.length
        ? { tools: options.tools, tool_choice: options.required ? "required" : "auto" }
        : {}),
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!response.ok) throw new Error(`DeepSeek API ${response.status}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: DeepSeekMessage }> };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("DeepSeek returned an empty response");
  return message;
}

export async function POST(request: Request) {
  const {
    question,
    includeTaskSpec = true,
    experimentVariant: requestedVariant,
  } = (await request.json()) as {
    question?: string;
    includeTaskSpec?: boolean;
    experimentVariant?: ToolExperimentVariant;
  };
  if (!question?.trim()) return Response.json({ error: "question is required" }, { status: 400 });
  const experimentVariant = normalizeExperimentVariant(requestedVariant);
  const tools = getExperimentalTools(experimentVariant);
  const stream = new ReadableStream({
    async start(controller) {
      let counter = 0;
      const emit = (event: Record<string, unknown>) =>
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ id: `evt-${++counter}`, ...event })}\n`),
        );
      try {
        const availableTools = tools.map((item) => item.function.name);
        let taskSpec: unknown = null;
        if (includeTaskSpec) {
          const planMessages: DeepSeekMessage[] = [
            {
              role: "system",
              content:
                "Analyze the user's task and return one concise JSON object with exactly these keys: objective (string), constraints (string[]), subtasks (string[]), missing_information (string[]), strategy (string[]). This is an observable task plan, not hidden chain-of-thought. Use Chinese and only facts from the user input.",
            },
            { role: "user", content: question.trim() },
          ];
          const breakdownMessage = await callDeepSeek(planMessages, { json: true });
          taskSpec = safeJson(breakdownMessage.content);
          emit({
            type: "status",
            title: "可选步骤：生成 Task Spec",
            detail: "Task Spec 将作为后续每轮模型请求的结构化上下文。",
            breakdown: taskSpec,
            protocol: {
              request: {
                model: "deepseek-chat",
                messages: planMessages,
                temperature: 0.2,
                response_format: { type: "json_object" },
              },
              response: breakdownMessage,
              parsed: taskSpec,
              parsedLabel: "程序解析后的 Task Spec",
            },
            trace: {
              source: "user_input + llm_response",
              produced_by: "deepseek-chat",
              trigger: "user_started_auto_run",
              available_tools: availableTools,
            },
            decision: {
              goal: "形成可执行计划",
              reason: "复杂问题需要先拆成可验证的子任务",
              evidence: question.trim(),
              next: "让模型从可用工具中选择下一步",
            },
            decisionSources: {
              goal: "preset",
              reason: "preset",
              evidence: "user_input",
              next: "preset",
            },
          });
          await sleep(700);
        }
        const messages: DeepSeekMessage[] = [
          {
            role: "system",
            content:
              "You are an autonomous tool-using analyst. Inspect the question and all available evidence on every turn. Select whichever remaining tool would materially improve the answer; do not follow a fixed order. If the evidence is already sufficient, do not call another tool. Keep arguments concise and never invent tool results.",
          },
          { role: "user", content: question.trim() },
        ];
        if (taskSpec)
          messages.push({
            role: "system",
            content: `Observable task specification for this run: ${JSON.stringify(taskSpec)}`,
          });
        const remaining = [...tools];
        let completedTools = 0;
        const decisionByTool: Record<string, DecisionSummary> = {
          search_solutions: {
            goal: "建立候选集",
            reason: "先获得与问题匹配的可比较方案",
            evidence: "当前只有用户约束，尚无候选产品",
            next: "调用 search_solutions",
          },
          analyze_reviews: {
            goal: "验证真实使用体验",
            reason: "评论证据可补充易用性与常见风险",
            evidence: "需要用口碑信号验证候选",
            next: "调用 analyze_reviews",
          },
          compare_pricing: {
            goal: "确认预算适配",
            reason: "价格证据用于判断方案是否满足成本约束",
            evidence: "最终推荐必须核对预算",
            next: "调用 compare_pricing",
          },
        };
        for (let round = 0; round < tools.length && remaining.length; round++) {
          const started = Date.now();
          const requestPayload = {
            model: "deepseek-chat",
            messages: [...messages],
            tools: remaining,
            tool_choice: "auto",
            temperature: 0.2,
          };
          const assistant = await callDeepSeek(messages, { tools: remaining });
          const call = assistant.tool_calls?.[0];
          if (!call) {
            emit({
              type: "status",
              title: "DeepSeek 决定停止调用工具",
              detail: "模型根据当前问题和已获得的工具结果，判断证据已经足够。",
              trace: {
                source: "assistant response without tool_calls",
                produced_by: "deepseek-chat",
                trigger: "autonomous_stop_decision",
                available_tools: remaining.map((item) => item.function.name),
              },
              decision: {
                goal: "结束工具循环",
                reason: assistant.content?.trim() || "当前证据足以生成结构化建议",
                evidence: `已完成 ${completedTools} 次工具调用`,
                next: "汇总已有证据",
              },
              decisionSources: {
                goal: "preset",
                reason: assistant.content?.trim() ? "llm_response" : "agent_runtime",
                evidence: "agent_runtime",
                next: "preset",
              },
            });
            break;
          }
          if (!presetResults[call.function.name]) throw new Error("模型返回了不可执行工具");
          const args = safeArgs(call.function.arguments);
          const selectedDecision = decisionByTool[call.function.name];
          emit({
            type: "status",
            title: `第 ${round + 1} 轮：DeepSeek 返回 tool_call`,
            detail: `程序从原始响应中解析出 ${call.function.name}`,
            selection: buildSelectionObservation(
              experimentVariant,
              remaining,
              call.function.name,
              assistant.content?.trim() || null,
            ),
            protocol: {
              request: requestPayload,
              response: assistant,
              parsed: { tool_call_id: call.id, tool_name: call.function.name, arguments: args },
            },
            decision: selectedDecision,
            trace: {
              source: "assistant.tool_calls[0]",
              produced_by: "deepseek-chat",
              trigger: "tool_choice_auto",
              available_tools: remaining.map((item) => item.function.name),
            },
          });
          await sleep(650);
          messages.push({ ...assistant, content: assistant.content ?? null, tool_calls: [call] });
          emit({
            type: "tool_call",
            title: `调用 ${call.function.name}`,
            tool: call.function.name,
            input: args,
            decision: { ...selectedDecision, next: "等待并检查工具返回值" },
            trace: {
              source: "model_selected_tool + parsed_arguments",
              produced_by: "agent_runtime",
              trigger: `deepseek_selected_${call.function.name}`,
            },
          });
          await sleep(1100);
          const output = presetResults[call.function.name](args);
          const toolMessage: DeepSeekMessage = {
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(output),
          };
          emit({
            type: "tool_result",
            title: `执行工具并追加 Observation`,
            tool: call.function.name,
            output,
            duration: Date.now() - started,
            protocol: {
              messageAppend: [
                { ...assistant, content: assistant.content ?? null, tool_calls: [call] },
                toolMessage,
              ],
              note: "自动模式会立即把 assistant.tool_calls 和 role: tool 结果加入 messages，然后开始下一轮。",
            },
            decision: {
              goal: "验证工具结果",
              reason: "返回值有效，可作为下一轮判断依据",
              evidence:
                call.function.name === "search_solutions"
                  ? "获得候选方案及评分"
                  : call.function.name === "analyze_reviews"
                    ? "获得评论汇总信号"
                    : "获得席位月度成本对比",
              next: round < 2 ? "结合新证据选择下一个工具" : "汇总全部证据",
            },
            trace: {
              source: "preset_tool_result",
              produced_by: "preset_tool_adapter",
              trigger: `agent_called_${call.function.name}`,
            },
          });
          messages.push(toolMessage);
          const usedIndex = remaining.findIndex(
            (item) => item.function.name === call.function.name,
          );
          if (usedIndex >= 0) remaining.splice(usedIndex, 1);
          completedTools += 1;
          await sleep(900);
        }
        emit({
          type: "status",
          title: "汇总证据并验证输出结构",
          detail: `将 ${completedTools} 次自主工具调用的结果整理为 recommendation schema`,
          decision: {
            goal: "生成可执行建议",
            reason: "模型已结束工具选择循环",
            evidence: `${completedTools} 次工具调用成功返回`,
            next: "生成并校验最终 JSON",
          },
          trace: {
            source: "conversation + approved_tool_results",
            produced_by: "agent_runtime",
            trigger: "autonomous_tool_loop_completed",
          },
        });
        await sleep(1000);
        messages.push({
          role: "system",
          content:
            "Return one valid JSON object with exactly these keys: summary (string), recommendation (string), evidence (string[]), risks (string[]), next_steps (string[]). Respond in Chinese and ground every claim in tool results.",
        });
        const finalRequest = {
          model: "deepseek-chat",
          messages: [...messages],
          temperature: 0.2,
          response_format: { type: "json_object" },
        };
        const finalMessage = await callDeepSeek(messages, { json: true });
        const finalResult = normalizeResult(JSON.parse(finalMessage.content ?? "{}"));
        await sleep(800);
        emit({
          type: "final",
          title: "模型未再返回 tool_calls，循环结束",
          detail: "DeepSeek 汇总 messages 中的全部 Observation，运行时完成 schema 校验。",
          output: finalResult,
          protocol: {
            request: finalRequest,
            response: finalMessage,
            parsed: finalResult,
            parsedLabel: "程序解析后的最终 JSON",
          },
          decision: {
            goal: "交付最终结论",
            reason: "建议同时满足预算约束并有工具证据支撑",
            evidence: `${finalResult.evidence.length} 条证据、${finalResult.risks.length} 项风险`,
            next: "ReAct 循环结束",
          },
          trace: {
            source: "all_tool_results + final_schema_prompt",
            produced_by: "deepseek-chat",
            trigger: "tool_loop_completed",
          },
        });
      } catch (error) {
        emit({
          type: "error",
          title: "Agent 运行失败",
          detail: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
