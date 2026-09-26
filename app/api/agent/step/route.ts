import { env } from "cloudflare:workers";
import {
  buildSelectionObservation,
  getExperimentalTools,
  normalizeExperimentVariant,
  type ToolExperimentVariant,
  type ToolName,
} from "@/lib/tool-experiment";

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type DeepSeekMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
type ToolProposal = { callId: string; name: ToolName; arguments: Record<string, unknown> };
type ToolHistory = ToolProposal & { result: unknown };
type PendingToolResult = ToolProposal & { result: unknown };
type ManualAction = "prepare" | "plan" | "decide" | "execute" | "append";
type FinalResult = {
  summary: string;
  recommendation: string;
  evidence: string[];
  risks: string[];
  next_steps: string[];
};

const toolNames: ToolName[] = ["search_solutions", "analyze_reviews", "compare_pricing"];
const catalogMatches = [
  { name: "Notion AI", score: 4.8, strengths: ["上手快", "知识库与协作一体化"] },
  { name: "Guru", score: 4.6, strengths: ["验证机制", "企业搜索"] },
  { name: "Slite", score: 4.5, strengths: ["轻量", "写作体验"] },
  { name: "Confluence AI", score: 4.3, strengths: ["复杂权限", "研发集成"] },
];
const reviewEvidence = {
  sample_size: 1284,
  sentiment: { positive: 0.82, neutral: 0.12, negative: 0.06 },
  highlights: [
    "检索速度与编辑体验最受好评",
    "权限配置是最常见的负面反馈",
    "小团队更偏好低维护方案",
  ],
};
const priceRows = [
  { name: "Notion AI", amount: 1080 },
  { name: "Guru", amount: 1420 },
  { name: "Slite", amount: 680 },
  { name: "Confluence AI", amount: 1560 },
];

function safeArgs(raw: string) {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function budgetFrom(question: string) {
  const match = question.match(/(?:预算|每月|月费)[^0-9]{0,8}(\d{2,6})\s*元?/);
  return match ? Number(match[1]) : 1500;
}
function normalizeResult(value: unknown): FinalResult {
  const result = (value && typeof value === "object" ? value : {}) as Partial<FinalResult>;
  const list = (items: unknown, fallback: string[]) =>
    Array.isArray(items) ? items.slice(0, 5).map(String) : fallback;
  return {
    summary:
      typeof result.summary === "string" ? result.summary : "已完成多轮自主工具调用并汇总证据。",
    recommendation:
      typeof result.recommendation === "string"
        ? result.recommendation
        : "建议先进行小范围试点，再根据实际效果扩大使用范围。",
    evidence: list(result.evidence, ["已完成候选、评论或价格证据检查"]),
    risks: list(result.risks, ["工具数据为演示用预设结果", "正式决策前需要核实最新信息"]),
    next_steps: list(result.next_steps, ["确认关键需求", "开始两周试点", "复盘实际效果"]),
  };
}

async function callDeepSeek(
  messages: DeepSeekMessage[],
  options: { tools?: unknown[]; json?: boolean } = {},
) {
  if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not configured");
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      temperature: 0.2,
      ...(options.tools?.length ? { tools: options.tools, tool_choice: "auto" } : {}),
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!response.ok) throw new Error(`DeepSeek API ${response.status}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: DeepSeekMessage }> };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("DeepSeek returned an empty response");
  return message;
}

function buildMessages(
  question: string,
  taskSpec: unknown,
  history: ToolHistory[],
): DeepSeekMessage[] {
  const messages: DeepSeekMessage[] = [
    {
      role: "system",
      content:
        "You are an autonomous tool-using analyst. At each turn, inspect the user's question and all tool results. Select whichever remaining tool would materially improve the answer; do not follow a fixed order. Use at most one tool per turn. If evidence is sufficient, do not call a tool. Never invent tool results or expose hidden chain-of-thought. You may give one short Chinese decision summary in content.",
    },
    { role: "user", content: question },
  ];
  if (taskSpec)
    messages.push({
      role: "system",
      content: `Observable task specification for this run: ${JSON.stringify(taskSpec)}`,
    });
  for (const item of history) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: item.callId,
          type: "function",
          function: { name: item.name, arguments: JSON.stringify(item.arguments) },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: item.callId,
      content: JSON.stringify(item.result),
    });
  }
  return messages;
}

function executePresetTool(name: ToolName, args: Record<string, unknown>, question: string) {
  if (name === "search_solutions")
    return {
      query: args.query ?? question,
      source: "preset_catalog_2026q3",
      matches: catalogMatches,
    };
  if (name === "analyze_reviews")
    return {
      candidates: args.candidates ?? catalogMatches.map((item) => item.name),
      ...reviewEvidence,
    };
  const budget = typeof args.budget === "number" ? args.budget : budgetFrom(question);
  return {
    currency: args.currency ?? "CNY",
    budget,
    monthly_estimates: priceRows.map((item) => ({ ...item, within_budget: item.amount <= budget })),
    note: "Preset estimates include 10 seats and exclude migration services.",
  };
}

async function synthesize(question: string, taskSpec: unknown, history: ToolHistory[]) {
  const messages = buildMessages(question, taskSpec, history);
  messages.push({
    role: "system",
    content:
      "Return one valid JSON object with exactly these keys: summary (string), recommendation (string), evidence (string[]), risks (string[]), next_steps (string[]). Respond in Chinese. Ground claims only in the supplied tool results and explicitly note missing evidence.",
  });
  const finalMessage = await callDeepSeek(messages, { json: true });
  return {
    result: normalizeResult(JSON.parse(finalMessage.content ?? "{}")),
    request: {
      model: "deepseek-chat",
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
    response: finalMessage,
  };
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    question?: string;
    action?: ManualAction;
    history?: ToolHistory[];
    proposal?: ToolProposal | null;
    pendingResult?: PendingToolResult | null;
    taskSpec?: unknown;
    experimentVariant?: ToolExperimentVariant;
  };
  const question = body.question?.trim();
  if (!question) return Response.json({ error: "question is required" }, { status: 400 });
  const action: ManualAction = body.action ?? "prepare";
  const history = Array.isArray(body.history) ? body.history.slice(0, 3) : [];
  const taskSpec = body.taskSpec ?? null;
  const experimentVariant = normalizeExperimentVariant(body.experimentVariant);
  const tools = getExperimentalTools(experimentVariant);

  try {
    if (action === "prepare") {
      const usedNames = new Set(history.map((item) => item.name));
      const remainingTools = tools.filter((item) => !usedNames.has(item.function.name));
      const modelInput = {
        round: history.length + 1,
        user_message: question,
        observations: history.map((item) => ({ tool: item.name, result_available: true })),
        available_tools: remainingTools.map((item) => item.function.name),
        tool_choice: "auto",
      };
      return Response.json({
        event: {
          type: "status",
          title: `第 ${history.length + 1} 轮：组装模型输入`,
          detail: "后端只是在组装即将发送的上下文，此时尚未调用 DeepSeek，也还没有生成 query。",
          input: modelInput,
          inputLabel: "model_input",
        },
        nextAction: "decide",
        history,
        proposal: null,
        taskSpec,
      });
    }

    if (action === "plan") {
      const message = await callDeepSeek(
        [
          {
            role: "system",
            content:
              "分析用户任务并返回一个简洁 JSON 对象，键必须恰好为 objective (string)、constraints (string[])、subtasks (string[])、missing_information (string[])、strategy (string[])。这是可观察的任务计划，不是隐藏思维链。只能使用用户输入中的事实。",
          },
          { role: "user", content: question },
        ],
        { json: true },
      );
      let breakdown: unknown = {};
      try {
        breakdown = JSON.parse(message.content ?? "{}");
      } catch {
        breakdown = {
          objective: question,
          constraints: [],
          subtasks: [],
          missing_information: [],
          strategy: [],
        };
      }
      const planMessages = [
        {
          role: "system",
          content:
            "分析用户任务并返回一个简洁 JSON 对象，键必须恰好为 objective (string)、constraints (string[])、subtasks (string[])、missing_information (string[])、strategy (string[])。这是可观察的任务计划，不是隐藏思维链。只能使用用户输入中的事实。",
        },
        { role: "user", content: question },
      ];
      return Response.json({
        event: {
          type: "status",
          title: "可选步骤：生成 Task Spec",
          detail: "这一步用于比较任务拆解是否会影响后续工具选择。",
          breakdown,
          protocol: {
            request: {
              model: "deepseek-chat",
              messages: planMessages,
              temperature: 0.2,
              response_format: { type: "json_object" },
            },
            response: message,
            parsed: breakdown,
            parsedLabel: "程序解析后的 Task Spec",
            note: "Task Spec 会保存，并在后续每一轮 Model Request 中传回 DeepSeek。",
          },
          trace: {
            source: "user_input + llm_response",
            produced_by: "deepseek-chat",
            trigger: "user_started_manual_run",
            available_tools: toolNames,
          },
          decision: {
            goal: "形成可复用任务规格",
            reason: "把复杂问题转成后续循环可使用的结构化输入",
            evidence: question,
            next: "带着 Task Spec 开始第一次 Tool Calling",
          },
          decisionSources: {
            goal: "preset",
            reason: "preset",
            evidence: "user_input",
            next: "preset",
          },
        },
        nextAction: "decide",
        history: [],
        taskSpec: breakdown,
      });
    }

    if (action === "execute") {
      const proposal = body.proposal;
      if (!proposal || !toolNames.includes(proposal.name))
        return Response.json({ error: "invalid tool proposal" }, { status: 400 });
      if (history.some((item) => item.name === proposal.name))
        return Response.json({ error: "tool already executed" }, { status: 400 });
      const started = Date.now();
      const result = executePresetTool(proposal.name, proposal.arguments, question);
      const nextHistory = [...history, { ...proposal, result }];
      const messageAppend = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: proposal.callId,
              type: "function",
              function: { name: proposal.name, arguments: JSON.stringify(proposal.arguments) },
            },
          ],
        },
        { role: "tool", tool_call_id: proposal.callId, content: JSON.stringify(result) },
      ];
      return Response.json({
        event: {
          type: "tool_result",
          title: `${proposal.name} 返回 Observation`,
          detail: "工具结果已自动加入 messages；下一步先展示如何组装新一轮模型输入。",
          tool: proposal.name,
          output: result,
          duration: Date.now() - started,
          protocol: {
            request: {
              adapter: "preset_tool_adapter",
              tool_name: proposal.name,
              arguments: proposal.arguments,
            },
            response: result,
            messageAppend,
            note: "assistant.tool_calls 与 role: tool 使用相同的 tool_call_id，下一轮 DeepSeek 才能关联调用和结果。",
          },
        },
        nextAction: "prepare",
        history: nextHistory,
        proposal: null,
      });
    }

    const usedNames = new Set(history.map((item) => item.name));
    const remainingTools = tools.filter((item) => !usedNames.has(item.function.name));
    if (remainingTools.length) {
      const messages = buildMessages(question, taskSpec, history);
      const requestPayload = {
        model: "deepseek-chat",
        messages,
        tools: remainingTools,
        tool_choice: "auto",
        temperature: 0.2,
      };
      const assistant = await callDeepSeek(messages, { tools: remainingTools });
      const call = assistant.tool_calls?.[0];
      if (call && remainingTools.some((item) => item.function.name === call.function.name)) {
        const proposal: ToolProposal = {
          callId: call.id,
          name: call.function.name as ToolName,
          arguments: safeArgs(call.function.arguments),
        };
        const reason =
          assistant.content?.trim() ||
          `DeepSeek 根据当前问题和 ${history.length} 组已有证据选择了这个工具。`;
        return Response.json({
          event: {
            type: "tool_call",
            title: `DeepSeek 返回 tool_call：${proposal.name}`,
            detail:
              "DeepSeek 在一次响应中直接返回最终工具名和 arguments；下方只解释可观察到的选择条件。工具尚未执行。",
            tool: proposal.name,
            input: proposal.arguments,
            selection: buildSelectionObservation(
              experimentVariant,
              remainingTools,
              proposal.name,
              assistant.content?.trim() || null,
            ),
            protocol: {
              request: requestPayload,
              response: assistant,
              parsed: {
                tool_call_id: proposal.callId,
                tool_name: proposal.name,
                arguments: proposal.arguments,
              },
              note: "程序读取 assistant.tool_calls[0]，再根据 name 从工具白名单中找到实际函数。",
            },
            trace: {
              source: "assistant.tool_calls[0]",
              produced_by: "deepseek-chat",
              trigger: "user_requested_next_agent_step",
              available_tools: remainingTools.map((item) => item.function.name),
            },
            decision: {
              goal: "获取下一项必要证据",
              reason,
              evidence: history.length
                ? `已获得 ${history.length} 组工具结果`
                : "目前只有用户问题，尚无工具证据",
              next: `等待用户批准执行 ${proposal.name}`,
            },
            decisionSources: {
              goal: "preset",
              reason: assistant.content?.trim() ? "llm_response" : "agent_runtime",
              evidence: "agent_runtime",
              next: "preset",
            },
          },
          nextAction: "execute",
          history,
          proposal,
          pendingResult: null,
          taskSpec,
        });
      }
    }

    const final = await synthesize(question, taskSpec, history);
    return Response.json({
      event: {
        type: "final",
        title: "DeepSeek 未返回 tool_calls，ReAct 循环结束",
        detail: `模型使用 ${history.length} 组 Observation 生成最终结构，Schema 校验通过。`,
        output: final.result,
        protocol: {
          request: final.request,
          response: final.response,
          parsed: final.result,
          parsedLabel: "程序解析后的最终 JSON",
          note: "当 assistant 不再返回 tool_calls 时，程序把响应视为最终答案并结束循环。",
        },
        trace: {
          source: "conversation + approved_tool_results",
          produced_by: "deepseek-chat",
          trigger: remainingTools.length ? "model_returned_no_tool_call" : "all_tools_used",
        },
        decision: {
          goal: "交付最终结论",
          reason: "模型自主判断不再需要更多工具",
          evidence: `${history.length} 组已批准的工具结果`,
          next: "ReAct 循环结束",
        },
        decisionSources: {
          goal: "preset",
          reason: "llm_response",
          evidence: "tool_result",
          next: "preset",
        },
      },
      nextAction: null,
      history,
      taskSpec,
      done: true,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
