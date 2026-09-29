import assert from "node:assert/strict";
import test from "node:test";
import { buildTraceLinks, type TraceEvent } from "../lib/trace-links.ts";

type ModelEvent = Extract<TraceEvent, { type: "model" }>;
type ToolEvent = Extract<TraceEvent, { type: "tool" }>;
type PlanEvent = Extract<TraceEvent, { type: "plan" }>;

const call = (id: string, name: string, input: string) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify({ input }) },
});

function model(round: number, calls: unknown[] = [], messages: unknown[] = []): ModelEvent {
  return {
    type: "model",
    round,
    request: { messages },
    response: { choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }] },
    status: 200,
  };
}

function tool(
  name: string,
  callId: string,
  input: string,
  result: unknown = "结果",
  round = 1,
): ToolEvent {
  const args = { input };
  const observation = { received_arguments: args, result };
  return {
    type: "tool",
    round,
    name,
    arguments: args,
    observation,
    appended_message: { role: "tool", tool_call_id: callId, content: JSON.stringify(observation) },
  };
}

function plannedTool(name: string, input: string, result: unknown, round: number): ToolEvent {
  const event = tool(name, "unused", input, result, round);
  event.appended_message = {
    role: "user",
    content: `执行器记录：工具 ${name}\n参数：${JSON.stringify(event.arguments)}\n结果：${JSON.stringify(event.observation)}`,
  };
  return event;
}

test("multiple calls in one round retain each exact source and next message index", () => {
  const first = tool("a", "call_a", "参数 A");
  const second = tool("b", "call_b", "参数 B");
  const calls = [call("call_a", "a", "参数 A"), call("call_b", "b", "参数 B")];
  const events: TraceEvent[] = [
    model(1, calls, [{ role: "user", content: "调用 a、b" }]),
    first,
    second,
    model(
      2,
      [],
      [
        { role: "system", content: "提示词" },
        { role: "user", content: "调用 a、b" },
        { role: "assistant", content: null, tool_calls: calls },
        first.appended_message,
        second.appended_message,
      ],
    ),
  ];
  const links = buildTraceLinks(events);
  assert.equal(links.length, 2);
  assert.deepEqual(links[0], {
    toolIndex: 1,
    callId: "call_a",
    source: {
      eventIndex: 0,
      path: "response.choices[0].message.tool_calls[0].function.arguments",
      value: '{"input":"参数 A"}',
    },
    context: { eventIndex: 3, path: "request.messages[3]", value: first.appended_message },
    issues: [],
  });
  assert.equal(
    links[1].source?.path,
    "response.choices[0].message.tool_calls[1].function.arguments",
  );
  assert.equal(links[1].context?.path, "request.messages[4]");
  assert.deepEqual(links[1].issues, []);
});

test("same tool name in separate rounds links by call id, not name", () => {
  const first = tool("a", "a_first", "第一次");
  const second = tool("a", "a_second", "第二次", "结果", 2);
  const links = buildTraceLinks([
    model(1, [call("a_first", "a", "第一次")]),
    first,
    model(2, [call("a_second", "a", "第二次")], [first.appended_message]),
    second,
    model(3, [], [first.appended_message, second.appended_message]),
  ]);
  assert.equal(links[0].source?.eventIndex, 0);
  assert.equal(links[0].context?.eventIndex, 2);
  assert.equal(links[1].source?.eventIndex, 2);
  assert.equal(links[1].context?.path, "request.messages[1]");
  assert.deepEqual(
    links.flatMap((link) => link.issues),
    [],
  );
});

test("a missing or swapped call id never falls back to matching tool name", () => {
  const missing = tool("a", "missing", "参数");
  const links = buildTraceLinks([
    model(1, [call("other_id", "a", "参数")]),
    missing,
    model(2, [], [tool("a", "other_id", "参数").appended_message]),
  ]);
  assert.equal(links[0].source, undefined);
  assert.equal(links[0].context, undefined);
  assert.match(links[0].issues.join(" "), /未找到相同 tool_call_id/);
  assert.match(links[0].issues.join(" "), /缺少这条回写消息/);

  const swapped = buildTraceLinks([
    model(1, [call("same_id", "b", "另一个参数")]),
    tool("a", "same_id", "参数"),
  ])[0];
  assert.equal(swapped.source?.value, '{"input":"另一个参数"}');
  assert.match(swapped.issues.join(" "), /工具名称不一致/);
  assert.match(swapped.issues.join(" "), /模型参数与工具收到的参数不一致/);
});

test("streaming without a later request waits silently but an omitted write warns", () => {
  const event = tool("a", "call_a", "参数");
  const history: TraceEvent[] = [model(1, [call("call_a", "a", "参数")]), event];
  assert.deepEqual(buildTraceLinks(history)[0].issues, []);
  assert.equal(buildTraceLinks(history)[0].context, undefined);
  const omitted = buildTraceLinks([...history, model(2, [], [])])[0];
  assert.match(omitted.issues.join(" "), /下一次模型请求缺少/);
  assert.equal(omitted.context, undefined);
  const late = buildTraceLinks([...history, model(2), model(3, [], [event.appended_message])])[0];
  assert.equal(late.context?.eventIndex, 3);
  assert.match(late.issues.join(" "), /下一次模型请求缺少/);
});

test("tool result mismatches are reported both at append and at the next request", () => {
  const event = tool("a", "call_a", "参数");
  const wrongMessage = { role: "tool", tool_call_id: "call_a", content: '{"result":"被改写"}' };
  const received = buildTraceLinks([
    model(1, [call("call_a", "a", "参数")]),
    event,
    model(2, [], [wrongMessage]),
  ])[0];
  assert.equal(received.context?.value, wrongMessage);
  assert.match(received.issues.join(" "), /回写消息与工具记录不一致/);
  assert.match(received.issues.join(" "), /结果与 Observation 不一致/);

  const appended = buildTraceLinks([
    model(1, [call("call_a", "a", "参数")]),
    { ...event, appended_message: wrongMessage },
  ])[0];
  assert.match(appended.issues.join(" "), /回写消息内容与 Observation 不一致/);
});

test("fixed and model plans map the indexed step and exact executor message", () => {
  for (const source of ["fixed", "model"] as const) {
    const plan: PlanEvent = {
      type: "plan",
      source,
      steps: [
        { name: "b", input: "先 B" },
        { name: "a", input: "再 A" },
      ],
      ...(source === "model" ? { status: 200 } : {}),
    };
    const first = plannedTool("b", "先 B", false, 1);
    const second = plannedTool("a", "再 A", null, 2);
    const links = buildTraceLinks([
      plan,
      first,
      second,
      model(
        2,
        [],
        [{ role: "user", content: "原始问题" }, first.appended_message, second.appended_message],
      ),
    ]);
    assert.equal(links[0].callId, undefined);
    assert.deepEqual(links[0].source, { eventIndex: 0, path: "steps[0].input", value: "先 B" });
    assert.deepEqual(links[1].source, { eventIndex: 0, path: "steps[1].input", value: "再 A" });
    assert.equal(links[0].context?.path, "request.messages[1]");
    assert.equal(links[1].context?.path, "request.messages[2]");
    assert.deepEqual(
      links.flatMap((link) => link.issues),
      [],
    );
  }
});

test("plan round mismatch is not repaired by searching the same tool name", () => {
  const plan: PlanEvent = {
    type: "plan",
    source: "fixed",
    steps: [
      { name: "b", input: "先 B" },
      { name: "a", input: "再 A" },
    ],
  };
  const wrongRound = buildTraceLinks([plan, plannedTool("a", "再 A", null, 1)])[0];
  assert.equal(wrongRound.source, undefined);
  assert.match(wrongRound.issues.join(" "), /对应计划步骤不一致/);
  const wrongArgs = buildTraceLinks([plan, plannedTool("a", "错了", null, 2)])[0];
  assert.equal(wrongArgs.source?.path, "steps[1].input");
  assert.match(wrongArgs.issues.join(" "), /计划参数与工具收到的参数不一致/);
});

test("null and false results and observations remain real values", () => {
  for (const value of [null, false, 0, ""]) {
    const event = tool("a", "call_a", "参数", value);
    const history = model(1, [call("call_a", "a", "参数")]);
    const links = buildTraceLinks([history, event, model(2, [], [event.appended_message])]);
    assert.deepEqual(links[0].issues, []);
    const primitive = {
      ...event,
      observation: value,
      appended_message: { role: "tool", tool_call_id: "call_a", content: JSON.stringify(value) },
    };
    assert.deepEqual(
      buildTraceLinks([history, primitive, model(2, [], [primitive.appended_message])])[0].issues,
      [],
    );
  }
});

test("failed model responses do not throw or become fake call sources", () => {
  for (const response of ["gateway failed", null, { error: { message: "出错" } }]) {
    const errorModel = { ...model(1), response, status: 400 };
    assert.deepEqual(buildTraceLinks([errorModel, { type: "error", message: "出错" }]), []);
    const link = buildTraceLinks([errorModel, tool("a", "call_a", "参数")])[0];
    assert.equal(link.source, undefined);
    assert.match(link.issues.join(" "), /未找到相同 tool_call_id/);
  }
  const event = tool("a", "call_a", "参数");
  const failedSource = buildTraceLinks([
    { ...model(1, [call("call_a", "a", "参数")]), status: 500 },
    event,
  ])[0];
  assert.equal(failedSource.source, undefined);
  assert.match(failedSource.issues.join(" "), /模型响应失败/);
  const failedNext = { ...model(2, [], [event.appended_message]), status: 400, response: "error" };
  const link = buildTraceLinks([model(1, [call("call_a", "a", "参数")]), event, failedNext])[0];
  assert.equal(link.context?.eventIndex, 2);
  assert.deepEqual(link.issues, []);
});

test("duplicate ids or duplicate context messages are ambiguous", () => {
  const event = tool("a", "duplicate", "参数");
  const duplicateSource = buildTraceLinks([
    model(1, [call("duplicate", "a", "参数"), call("duplicate", "b", "参数")]),
    event,
  ])[0];
  assert.equal(duplicateSource.source, undefined);
  assert.match(duplicateSource.issues.join(" "), /tool_call_id 重复/);
  const duplicateContext = buildTraceLinks([
    model(1, [call("duplicate", "a", "参数")]),
    event,
    model(2, [], [event.appended_message, event.appended_message]),
  ])[0];
  assert.equal(duplicateContext.context, undefined);
  assert.match(duplicateContext.issues.join(" "), /重复回写消息/);
});

test("malformed arguments keep their source but show a parse issue", () => {
  const badCall = { id: "call_a", function: { name: "a", arguments: "not json" } };
  const link = buildTraceLinks([model(1, [badCall]), tool("a", "call_a", "参数")])[0];
  assert.equal(link.source?.value, "not json");
  assert.match(link.issues.join(" "), /不是有效 JSON/);
  const missingId = tool("a", "", "参数");
  const missing = buildTraceLinks([model(1, [call("", "a", "参数")]), missingId])[0];
  assert.equal(missing.callId, undefined);
  assert.equal(missing.source, undefined);
  assert.match(missing.issues.join(" "), /缺少 tool_call_id/);
});

test("observation received_arguments drift is visible and key ordering is ignored", () => {
  const event = tool("a", "call_a", "参数");
  const altered = {
    ...event,
    observation: { received_arguments: { input: "不同" }, result: "结果" },
  };
  const link = buildTraceLinks([model(1, [call("call_a", "a", "参数")]), altered])[0];
  assert.match(link.issues.join(" "), /Observation 记录的参数/);
  const reordered = {
    ...event,
    appended_message: {
      role: "tool",
      tool_call_id: "call_a",
      content: '{"result":"结果","received_arguments":{"input":"参数"}}',
    },
  };
  assert.deepEqual(
    buildTraceLinks([model(1, [call("call_a", "a", "参数")]), reordered])[0].issues,
    [],
  );
});
