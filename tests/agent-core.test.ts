import assert from "node:assert/strict";
import test from "node:test";
import {
  appendToolResults,
  createFixedPlan,
  createModelRequest,
  parseModelPlan,
  parseRunInput,
  parseToolArguments,
  validateReactToolCall,
  type ChatMessage,
  type DemoTool,
  type ToolCall,
} from "../lib/agent-core.ts";

const tools = [
  { name: "a", description: "调用 a", result: { value: "A" } },
  { name: "b", description: "调用 b", result: { value: "B" } },
];

test("tool definitions stay configurable and names must be unique", () => {
  const parsed = parseRunInput({ query: "调用 a", tools });
  assert.equal(parsed.tools.length, 2);
  assert.equal(parsed.architecture, "react");
  assert.equal(
    parseRunInput({ query: "调用 a", tools, architecture: "fixed" }).architecture,
    "fixed",
  );
  assert.throws(() => parseRunInput({ query: "调用 a", tools, architecture: "unknown" }), /请检查/);
  assert.throws(() => parseRunInput({ query: "调用 a", tools: [tools[0], tools[0]] }), /不能重复/);
  assert.throws(
    () => parseRunInput({ query: "调用 a", tools: [{ ...tools[0], name: "bad name" }] }),
    /请检查/,
  );
});

test("fixed flow follows configured order for named tools", () => {
  assert.deepEqual(createFixedPlan("先调用 b，再调用 a", tools), [
    { name: "a", input: "先调用 b，再调用 a" },
    { name: "b", input: "先调用 b，再调用 a" },
  ]);
  assert.deepEqual(
    createFixedPlan("处理这个任务", tools).map((step) => step.name),
    ["a", "b"],
  );
});

test("model plan accepts only available tools once", () => {
  assert.deepEqual(parseModelPlan('{"steps":[{"name":"b","input":"给 b 的参数"}]}', tools), [
    { name: "b", input: "给 b 的参数" },
  ]);
  assert.throws(
    () => parseModelPlan('{"steps":[{"name":"a","input":"x"},{"name":"a","input":"y"}]}', tools),
    /重复工具/,
  );
  assert.throws(() => parseModelPlan('{"steps":[{"name":"c","input":"x"}]}', tools), /未知/);
});

test("the next model request contains the full assistant call and Observation", () => {
  const initial: ChatMessage[] = [
    { role: "system", content: "system" },
    { role: "user", content: "调用 a 和 b" },
  ];
  const call: ToolCall = {
    id: "call_a",
    type: "function",
    function: { name: "a", arguments: '{"input":"先调用 a"}' },
  };
  const args = parseToolArguments(call.function.arguments);
  const observation = { received_arguments: args, result: tools[0].result };
  const next = appendToolResults(initial, { role: "assistant", content: null }, [
    { call, observation },
  ]);
  const request = createModelRequest(next, [tools[1]]);

  assert.deepEqual(request.messages, [
    ...initial,
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "call_a", content: JSON.stringify(observation) },
  ]);
  assert.deepEqual(
    request.tools?.map((tool) => tool.function.name),
    ["b"],
  );
});

test("an exhausted tool list produces a final model request without tools", () => {
  const request = createModelRequest([{ role: "user", content: "完成" }], []);
  assert.equal("tools" in request, false);
  assert.equal("tool_choice" in request, false);
  assert.throws(() => parseToolArguments("[]"), /JSON 对象/);
});

function makeCall(name: string, id = `call_${name}`, input = `调用 ${name}`): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify({ input }) } };
}

test("ReAct validates one call without changing arguments or execution history", () => {
  const used = new Set<string>();
  const usedCallIds = new Set<string>();
  for (const calls of [undefined, null, []]) {
    assert.equal(validateReactToolCall(calls, tools, used, usedCallIds), null);
  }
  const call = makeCall("a");
  call.function.arguments = JSON.stringify({ input: "  保留原参数  ", extra: { value: 1 } });
  assert.deepEqual(validateReactToolCall([call], tools, used, usedCallIds), {
    call,
    tool: tools[0],
    arguments: { input: "  保留原参数  ", extra: { value: 1 } },
  });
  assert.equal(used.size, 0);
  assert.equal(usedCallIds.size, 0);
});

test("ReAct rejects malformed calls and arguments before execution", () => {
  const validate = (calls: unknown) => validateReactToolCall(calls, tools, new Set(), new Set());
  assert.throws(() => validate({}), /tool_calls 必须是数组/);
  assert.throws(() => validate([null]), /调用格式无效/);
  assert.throws(() => validate([{ ...makeCall("a"), type: "custom" }]), /必须是 function/);
  assert.throws(() => validate([{ ...makeCall("a"), id: "  " }]), /调用 ID/);
  assert.throws(() => validate([{ ...makeCall("a"), function: null }]), /工具名称/);
  assert.throws(() => validate([makeCall("unknown")]), /未知工具 unknown/);
  assert.throws(
    () => validate([{ ...makeCall("a"), function: { name: "a", arguments: {} } }]),
    /必须是 JSON 字符串/,
  );
  for (const raw of ["not json", "[]", "null", '"text"', "{}", '{"input":5}']) {
    const call = makeCall("a");
    call.function.arguments = raw;
    assert.throws(() => validate([call]), /JSON|input/);
  }
});

// Feed model responses through the same request, validation, and history helpers as the route.
function runReact(
  availableTools: DemoTool[],
  model: (request: ReturnType<typeof createModelRequest>) => ChatMessage,
  executed: string[] = [],
) {
  let messages: ChatMessage[] = [{ role: "user", content: "先观察 a，再决定是否调用 b" }];
  const used = new Set<string>();
  const usedCallIds = new Set<string>();
  const requests: ReturnType<typeof createModelRequest>[] = [];
  for (let round = 0; round <= availableTools.length + 1; round++) {
    const request = createModelRequest(
      messages,
      availableTools.filter((tool) => !used.has(tool.name)),
    );
    requests.push(request);
    const assistant = model(request);
    const selected = validateReactToolCall(assistant.tool_calls, availableTools, used, usedCallIds);
    if (!selected) return { requests, executed, answer: assistant.content };
    const { call, tool, arguments: args } = selected;
    const observation = { received_arguments: args, result: tool.result };
    executed.push(tool.name);
    used.add(tool.name);
    usedCallIds.add(call.id);
    messages = appendToolResults(messages, assistant, [{ call, observation }]);
  }
  throw new Error("测试循环超出预期轮数");
}

test("ReAct rejects a batch of calls without executing even the first tool", () => {
  const executed: string[] = [];
  assert.throws(
    () =>
      runReact(
        tools,
        () => ({ role: "assistant", content: null, tool_calls: [makeCall("a"), makeCall("b")] }),
        executed,
      ),
    /每轮只能调用一个工具.*未执行任何工具/,
  );
  assert.deepEqual(executed, []);
});

test("ReAct rejects repeated tools and call IDs across rounds", () => {
  for (const [secondCall, error] of [
    [makeCall("a", "another_id"), /工具 a 已调用/],
    [makeCall("b", "call_a"), /调用 ID call_a 已使用/],
  ] as const) {
    let round = 0;
    const executed: string[] = [];
    assert.throws(
      () =>
        runReact(
          tools,
          () => ({
            role: "assistant",
            content: null,
            tool_calls: [round++ === 0 ? makeCall("a") : secondCall],
          }),
          executed,
        ),
      error,
    );
    assert.deepEqual(executed, ["a"]);
  }
});

test("ReAct observes a before deciding b and uses three model requests for a → b → answer", () => {
  for (const needsB of [true, false]) {
    const conditionalTools = [{ ...tools[0], result: { needs_b: needsB, value: "A" } }, tools[1]];
    const result = runReact(conditionalTools, (request) => {
      const observations = request.messages.filter((message) => message.role === "tool");
      if (observations.length === 0) {
        assert.deepEqual(
          request.tools?.map((tool) => tool.function.name),
          ["a", "b"],
        );
        return { role: "assistant", content: null, tool_calls: [makeCall("a")] };
      }
      const observation = JSON.parse(observations[0].content!);
      assert.deepEqual(observation, {
        received_arguments: { input: "调用 a" },
        result: { needs_b: needsB, value: "A" },
      });
      assert.equal(observations[0].tool_call_id, "call_a");
      assert.deepEqual(request.messages[1].tool_calls, [makeCall("a")]);
      if (observations.length === 1) {
        assert.deepEqual(
          request.tools?.map((tool) => tool.function.name),
          ["b"],
        );
        if (observation.result.needs_b) {
          return {
            role: "assistant",
            content: null,
            tool_calls: [makeCall("b", "call_b", "根据 A 继续")],
          };
        }
      } else {
        assert.equal(request.tools, undefined);
        assert.equal(observations[1].tool_call_id, "call_b");
        assert.deepEqual(JSON.parse(observations[1].content!), {
          received_arguments: { input: "根据 A 继续" },
          result: tools[1].result,
        });
      }
      return { role: "assistant", content: "结果已足够" };
    });
    assert.deepEqual(result.executed, needsB ? ["a", "b"] : ["a"]);
    assert.equal(result.requests.length, needsB ? 3 : 2);
    assert.equal(result.answer, "结果已足够");
  }
});
