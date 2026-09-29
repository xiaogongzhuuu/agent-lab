import assert from "node:assert/strict";
import test from "node:test";
import {
  appendToolResults,
  createFixedPlan,
  createModelRequest,
  parseModelPlan,
  parseRunInput,
  parseToolArguments,
  type ChatMessage,
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
