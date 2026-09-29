import { z } from "zod";

const toolSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/),
    description: z.string().trim().min(1).max(300),
    result: z.unknown(),
  })
  .strict();

const runSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    tools: z.array(toolSchema).min(1).max(8),
    architecture: z.enum(["react", "fixed", "plan"]).default("react"),
  })
  .strict();

export type DemoTool = z.infer<typeof toolSchema>;
export type PlanStep = { name: string; input: string };
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export function parseRunInput(value: unknown) {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "输入"))];
    throw new Error(`请检查 ${fields.join("、")}`);
  }
  const names = parsed.data.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) throw new Error("工具名称不能重复");
  for (const tool of parsed.data.tools) {
    if (tool.result === undefined) throw new Error(`工具 ${tool.name} 缺少 result`);
    if (JSON.stringify(tool.result).length > 4000) {
      throw new Error(`工具 ${tool.name} 的 result 超过 4000 字符`);
    }
  }
  return parsed.data;
}

export function createModelRequest(messages: ChatMessage[], available: DemoTool[]) {
  return {
    model: "deepseek-chat",
    messages,
    temperature: 0,
    ...(available.length
      ? {
          tools: available.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: {
                type: "object",
                properties: {
                  input: { type: "string", description: "传给工具的输入内容" },
                },
                required: ["input"],
              },
            },
          })),
          tool_choice: "auto",
        }
      : {}),
  };
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("模型返回的工具参数不是有效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("工具参数必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

export function createFixedPlan(query: string, tools: DemoTool[]): PlanStep[] {
  const mentioned = tools.filter((tool) =>
    new RegExp(`(^|[^a-zA-Z0-9_])${tool.name}(?=$|[^a-zA-Z0-9_])`).test(query),
  );
  return (mentioned.length ? mentioned : tools).map((tool) => ({ name: tool.name, input: query }));
}

export function parseModelPlan(content: string, tools: DemoTool[]): PlanStep[] {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new Error("模型计划不是有效 JSON");
  }
  const schema = z.object({
    steps: z.array(z.object({ name: z.string(), input: z.string().max(2000) })).max(tools.length),
  });
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("模型计划格式无效");
  const names = parsed.data.steps.map((step) => step.name);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !tools.some((tool) => tool.name === name))
  ) {
    throw new Error("模型计划包含未知或重复工具");
  }
  return parsed.data.steps;
}

export function appendToolResults(
  messages: ChatMessage[],
  assistant: ChatMessage,
  results: Array<{ call: ToolCall; observation: unknown }>,
): ChatMessage[] {
  return [
    ...messages,
    { role: "assistant", content: assistant.content, tool_calls: results.map((item) => item.call) },
    ...results.map(({ call, observation }) => ({
      role: "tool" as const,
      tool_call_id: call.id,
      content: JSON.stringify(observation),
    })),
  ];
}
