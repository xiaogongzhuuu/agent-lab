import { env } from "cloudflare:workers";
import {
  appendToolResults,
  createFixedPlan,
  createModelRequest,
  parseModelPlan,
  parseRunInput,
  parseToolArguments,
  type ChatMessage,
  type PlanStep,
  type ToolCall,
} from "@/lib/agent-core";

const reactPrompt =
  "你是一个最小化的工具调用 Agent。每轮根据用户请求和已有工具结果，决定调用哪个尚未使用的工具，或直接给出结论。每次响应尽量只调用一个工具。若用户要求根据前一个工具的结果决定是否调用后续工具，必须先观察前一个结果；不要仅因为任务提到工具名就提前调用它。已调用工具会从当前 tools 列表移除；messages 中已有的 assistant tool_calls 和对应 tool 消息代表真实的历史调用及结果，即使当前 tools 不再列出，也必须将它们视为已完成的调用，不要否认。不要编造工具结果。最终用中文简短回答。";
const summaryPrompt =
  "你负责总结一个工具执行流程。后续消息是执行器真实记录的工具参数和返回结果。只依据用户问题与这些结果，用中文简短回答；不要否认已经完成的调用，不要编造结果。";
const encoder = new TextEncoder();

type ModelPayload = {
  choices?: Array<{
    message?: { role?: string; content?: string | null; tool_calls?: ToolCall[] };
  }>;
  error?: { message?: string };
};
type ModelResult = { payload: ModelPayload | string; status: number };

async function callModel(
  requestBody: ReturnType<typeof createModelRequest>,
  signal: AbortSignal,
): Promise<ModelResult> {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });
  const rawResponse = await response.text();
  let payload: ModelPayload | string;
  try {
    payload = JSON.parse(rawResponse) as ModelPayload;
  } catch {
    payload = rawResponse;
  }
  return { payload, status: response.status };
}

function assistantFrom(result: ModelResult) {
  if (result.status < 200 || result.status >= 300) {
    const detail =
      typeof result.payload === "string" ? result.payload : result.payload.error?.message;
    throw new Error(`DeepSeek API ${result.status}${detail ? `：${detail}` : ""}`);
  }
  const assistant =
    typeof result.payload === "string" ? undefined : result.payload.choices?.[0]?.message;
  if (!assistant) throw new Error("模型没有返回 message");
  return assistant;
}

export async function POST(request: Request) {
  let input: ReturnType<typeof parseRunInput>;
  try {
    input = parseRunInput(await request.json());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "输入格式无效" },
      { status: 400 },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      async function runReact() {
        let messages: ChatMessage[] = [
          { role: "system", content: reactPrompt },
          { role: "user", content: input.query },
        ];
        const used = new Set<string>();
        for (let round = 1; round <= input.tools.length + 1; round++) {
          const available = input.tools.filter((tool) => !used.has(tool.name));
          const requestBody = createModelRequest(messages, available);
          const result = await callModel(requestBody, request.signal);
          emit({
            type: "model",
            round,
            purpose: "decision",
            request: requestBody,
            response: result.payload,
            status: result.status,
          });
          const assistant = assistantFrom(result);
          const calls = assistant.tool_calls ?? [];
          if (!calls.length) {
            emit({
              type: "final",
              answer: assistant.content ?? "",
              reason: available.length ? "模型决定结束" : "可用工具已用完",
            });
            return;
          }

          const selected = new Set<string>();
          const results = calls.map((call) => {
            const tool = available.find((item) => item.name === call.function?.name);
            if (!tool || selected.has(tool.name)) throw new Error("模型返回了未知或重复的工具调用");
            selected.add(tool.name);
            const args = parseToolArguments(call.function.arguments);
            return {
              call,
              name: tool.name,
              arguments: args,
              observation: { received_arguments: args, result: tool.result },
            };
          });
          messages = appendToolResults(
            messages,
            { role: "assistant", content: assistant.content ?? null },
            results,
          );
          for (const item of results) {
            used.add(item.name);
            emit({
              type: "tool",
              round,
              name: item.name,
              arguments: item.arguments,
              observation: item.observation,
              next: "再问模型",
              appended_message: {
                role: "tool",
                tool_call_id: item.call.id,
                content: JSON.stringify(item.observation),
              },
            });
          }
        }
        throw new Error("达到最大轮数，循环已停止");
      }

      async function executePlan(steps: PlanStep[], source: "fixed" | "model") {
        const messages: ChatMessage[] = [
          { role: "system", content: summaryPrompt },
          { role: "user", content: input.query },
        ];
        for (const [index, step] of steps.entries()) {
          const tool = input.tools.find((item) => item.name === step.name);
          if (!tool) throw new Error(`找不到工具 ${step.name}`);
          const args = { input: step.input };
          const observation = { received_arguments: args, result: tool.result };
          const appendedMessage: ChatMessage = {
            role: "user",
            content: `执行器记录：工具 ${tool.name}\n参数：${JSON.stringify(args)}\n结果：${JSON.stringify(observation)}`,
          };
          messages.push(appendedMessage);
          emit({
            type: "tool",
            round: index + 1,
            name: tool.name,
            arguments: args,
            observation,
            appended_message: appendedMessage,
            next: index === steps.length - 1 ? "交给模型总结" : "执行下一工具",
          });
        }

        const requestBody = createModelRequest(messages, []);
        const result = await callModel(requestBody, request.signal);
        emit({
          type: "model",
          round: source === "model" ? 2 : 1,
          purpose: "summary",
          used_tools: steps.map((step) => step.name),
          request: requestBody,
          response: result.payload,
          status: result.status,
        });
        const assistant = assistantFrom(result);
        emit({
          type: "final",
          answer: assistant.content ?? "",
          reason: source === "model" ? "计划执行完成" : "固定流程完成",
        });
      }

      try {
        if (!env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not configured");
        if (input.architecture === "react") {
          await runReact();
        } else if (input.architecture === "fixed") {
          const steps = createFixedPlan(input.query, input.tools);
          emit({ type: "plan", source: "fixed", steps });
          await executePlan(steps, "fixed");
        } else {
          const toolList = input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
          }));
          const planPrompt =
            `你是工具执行计划器。根据任务，从工具列表中选出需要调用的工具，并决定顺序和每个工具的 input。每个工具最多调用一次。input 必须是非空字符串；任务没有具体参数时，填入原始问题。` +
            `只返回 JSON 对象：{"steps":[{"name":"工具名","input":"输入内容"}]}。不需要工具时返回 {"steps":[]}。工具列表：${JSON.stringify(toolList)}`;
          const requestBody = createModelRequest(
            [
              { role: "system", content: planPrompt },
              { role: "user", content: input.query },
            ],
            [],
          );
          const result = await callModel(requestBody, request.signal);
          let steps: PlanStep[] = [];
          let planError: unknown;
          try {
            const assistant = assistantFrom(result);
            steps = parseModelPlan(assistant.content ?? "", input.tools).map((step) => ({
              ...step,
              input: step.input.trim() || input.query,
            }));
          } catch (error) {
            planError = error;
          }
          emit({
            type: "plan",
            source: "model",
            steps,
            request: requestBody,
            response: result.payload,
            status: result.status,
          });
          if (planError) throw planError;
          await executePlan(steps, "model");
        }
      } catch (error) {
        emit({
          type: "error",
          message: error instanceof Error ? error.message : "运行失败",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
