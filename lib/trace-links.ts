export type TraceEvent =
  | {
      type: "model";
      round: number;
      purpose?: "decision" | "summary";
      used_tools?: string[];
      request: unknown;
      response: unknown;
      status: number;
    }
  | {
      type: "tool";
      round: number;
      name: string;
      arguments: unknown;
      observation: unknown;
      appended_message: unknown;
      next?: string;
    }
  | {
      type: "plan";
      source: "fixed" | "model";
      steps: Array<{ name: string; input: string }>;
      request?: unknown;
      response?: unknown;
      status?: number;
    }
  | { type: "final"; answer: string; reason: string }
  | { type: "error"; message: string };

export type TraceReference = { eventIndex: number; path: string; value: unknown };

export type ToolTraceLink = {
  toolIndex: number;
  callId?: string;
  source?: TraceReference;
  context?: TraceReference;
  issues: string[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
    );
  }
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (!leftRecord || !rightRecord) return false;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function parseJson(value: unknown): { valid: boolean; value?: unknown } {
  if (typeof value !== "string") return { valid: false };
  try {
    return { valid: true, value: JSON.parse(value) };
  } catch {
    return { valid: false };
  }
}

function toolCalls(response: unknown): unknown[] {
  const choices = record(response)?.choices;
  const calls = record(
    record(Array.isArray(choices) ? choices[0] : undefined)?.message,
  )?.tool_calls;
  return Array.isArray(calls) ? calls : [];
}

function requestMessages(request: unknown): unknown[] {
  const messages = record(request)?.messages;
  return Array.isArray(messages) ? messages : [];
}

function failed(status: number | undefined): boolean {
  return status !== undefined && (status < 200 || status >= 300);
}

export function buildTraceLinks(events: readonly TraceEvent[]): ToolTraceLink[] {
  const links: ToolTraceLink[] = [];
  events.forEach((event, toolIndex) => {
    if (event.type !== "tool") return;
    const link: ToolTraceLink = { toolIndex, issues: [] };
    links.push(link);
    const warn = (issue: string) => {
      if (!link.issues.includes(issue)) link.issues.push(issue);
    };
    const appended = record(event.appended_message);
    const callId = appended?.tool_call_id;
    const usesToolCall = appended?.role === "tool" || typeof callId === "string";

    if (usesToolCall) {
      if (typeof callId !== "string" || !callId) {
        warn("回写消息缺少 tool_call_id，无法定位调用来源");
      } else {
        link.callId = callId;
        const sources: Array<{
          eventIndex: number;
          callIndex: number;
          call: Record<string, unknown>;
        }> = [];
        events.slice(0, toolIndex).forEach((previous, eventIndex) => {
          if (previous.type !== "model") return;
          toolCalls(previous.response).forEach((rawCall, callIndex) => {
            const call = record(rawCall);
            if (call?.id === callId) sources.push({ eventIndex, callIndex, call });
          });
        });
        if (!sources.length) {
          warn("未找到相同 tool_call_id 的模型调用");
        } else if (sources.length > 1) {
          warn("tool_call_id 重复，无法确定调用来源");
        } else {
          const source = sources[0];
          const model = events[source.eventIndex] as Extract<TraceEvent, { type: "model" }>;
          const fn = record(source.call.function);
          if (failed(model.status)) {
            warn("调用来源的模型响应失败");
          } else if (!fn || !Object.hasOwn(fn, "arguments")) {
            warn("模型调用缺少 arguments");
          } else {
            link.source = {
              eventIndex: source.eventIndex,
              path: `response.choices[0].message.tool_calls[${source.callIndex}].function.arguments`,
              value: fn.arguments,
            };
            const parsed = parseJson(fn.arguments);
            if (!parsed.valid) warn("模型 arguments 不是有效 JSON");
            else if (!sameValue(parsed.value, event.arguments))
              warn("模型参数与工具收到的参数不一致");
            if (fn.name !== event.name) warn("调用来源的工具名称不一致");
            if (model.round !== event.round) warn("调用来源的轮次不一致");
          }
        }
      }
      if (appended?.role !== "tool") warn("回写消息的 role 应为 tool");
      const content = parseJson(appended?.content);
      if (!content.valid || !sameValue(content.value, event.observation)) {
        warn("回写消息内容与 Observation 不一致");
      }
    } else {
      const planIndex = events.findLastIndex(
        (previous, index) => index < toolIndex && previous.type === "plan",
      );
      const plan =
        planIndex >= 0 ? (events[planIndex] as Extract<TraceEvent, { type: "plan" }>) : undefined;
      const stepIndex = event.round - 1;
      const step =
        Number.isInteger(stepIndex) && stepIndex >= 0 ? plan?.steps[stepIndex] : undefined;
      if (!plan) warn("未找到工具的调用计划或 tool_call_id");
      else if (failed(plan.status)) warn("调用来源的计划请求失败");
      else if (!step) warn("计划中没有对应步骤");
      else if (step.name !== event.name) warn("工具与对应计划步骤不一致");
      else {
        link.source = {
          eventIndex: planIndex,
          path: `steps[${stepIndex}].input`,
          value: step.input,
        };
        if (!sameValue({ input: step.input }, event.arguments))
          warn("计划参数与工具收到的参数不一致");
      }
      if (appended?.role !== "user") warn("执行器回写消息的 role 应为 user");
      const expected = `执行器记录：工具 ${event.name}\n参数：${JSON.stringify(event.arguments)}\n结果：${JSON.stringify(event.observation)}`;
      if (appended?.content !== expected) warn("回写消息内容与工具参数或 Observation 不一致");
    }

    const observation = record(event.observation);
    if (
      observation &&
      Object.hasOwn(observation, "received_arguments") &&
      !sameValue(observation.received_arguments, event.arguments)
    ) {
      warn("Observation 记录的参数与工具收到的参数不一致");
    }

    let sawNextRequest = false;
    for (let eventIndex = toolIndex + 1; eventIndex < events.length; eventIndex++) {
      const next = events[eventIndex];
      if (next.type !== "model") continue;
      const messages = requestMessages(next.request);
      const matches = messages.flatMap((message, index) => {
        const candidate = record(message);
        const matchesMessage = usesToolCall
          ? link.callId !== undefined &&
            candidate?.role === "tool" &&
            candidate.tool_call_id === link.callId
          : appended?.role === "user" && sameValue(message, event.appended_message);
        return matchesMessage ? [index] : [];
      });
      if (!sawNextRequest && !matches.length) warn("下一次模型请求缺少这条回写消息");
      sawNextRequest = true;
      if (!matches.length) continue;
      if (matches.length > 1) {
        warn("模型请求中存在重复回写消息，无法确定位置");
        break;
      }
      const messageIndex = matches[0];
      const message = messages[messageIndex];
      link.context = { eventIndex, path: `request.messages[${messageIndex}]`, value: message };
      if (!sameValue(message, event.appended_message)) warn("模型请求中的回写消息与工具记录不一致");
      if (usesToolCall) {
        const content = parseJson(record(message)?.content);
        if (!content.valid || !sameValue(content.value, event.observation)) {
          warn("模型请求中的结果与 Observation 不一致");
        }
      }
      break;
    }
  });
  return links;
}
