"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Box,
  Braces,
  Check,
  ChevronDown,
  CircleStop,
  Clock3,
  Copy,
  Database,
  FlaskConical,
  Hand,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  StepForward,
  Wrench,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type ProtocolTrace = {
  request?: unknown;
  response?: unknown;
  parsed?: unknown;
  messageAppend?: unknown;
  note?: string;
};
type ToolSelection = {
  experiment: ExperimentVariant;
  selected: { name: string; description?: string };
  not_selected_this_round: Array<{ name: string; description: string }>;
  tool_order: string[];
  model_summary: string;
};
type AgentEvent = {
  id: string;
  type: "status" | "tool_call" | "tool_result" | "final" | "error";
  title: string;
  detail?: string;
  tool?: string;
  input?: Record<string, unknown>;
  inputLabel?: string;
  output?: unknown;
  duration?: number;
  protocol?: ProtocolTrace;
  selection?: ToolSelection;
};
type FinalResult = {
  summary: string;
  recommendation: string;
  evidence: string[];
  risks: string[];
  next_steps: string[];
};
type RunMode = "auto" | "manual";
type ManualAction = "prepare" | "decide" | "execute";
type ExperimentVariant = "control" | "ambiguous" | "budget_first";
type ToolProposal = {
  callId: string;
  name: "search_solutions" | "analyze_reviews" | "compare_pricing";
  arguments: Record<string, unknown>;
};
type ToolHistory = ToolProposal & { result: unknown };

const suggestions = [
  "帮我为 10 人产品团队选择 AI 知识库方案，预算每月 1500 元",
  "10 人产品团队预算降到每月 800 元，优先考虑上手快和低维护",
  "比较 Notion AI、Guru 和 Slite，给出适合 10 人初创团队的建议",
  "团队主要使用 Slack 和 Jira，哪种 AI 知识库集成体验更合适",
  "我们有复杂的文档权限，预算每月 1500 元，应该选哪个方案",
  "需要从旧文档库迁移 500 篇资料，请评估方案和迁移风险",
  "按 10 个席位计算半年总成本，并给出性价比最高的选择",
  "重点分析候选方案的差评和潜在风险，再给出保守建议",
];
const toolIcons: Record<string, typeof Search> = {
  search_solutions: Search,
  analyze_reviews: Database,
  compare_pricing: Box,
};
const experimentOptions: Array<{ value: ExperimentVariant; title: string; detail: string }> = [
  { value: "control", title: "清晰职责", detail: "描述区分候选、评论和价格" },
  { value: "ambiguous", title: "模糊重叠", detail: "三个工具使用相同描述" },
  { value: "budget_first", title: "预算优先", detail: "价格工具排第一并强化预算提示" },
];

function jsonTokenClass(token: string) {
  const trimmed = token.trim();
  if (/^"(?:\\.|[^"\\])*"\s*:$/.test(trimmed)) {
    const key = trimmed.slice(1, trimmed.lastIndexOf('"'));
    return `json-key ${["messages", "tools", "tool_calls", "arguments", "content", "role", "name", "tool_call_id"].includes(key) ? "important" : ""}`;
  }
  if (/^"(?:\\.|[^"\\])*"$/.test(trimmed)) {
    let value = "";
    try {
      value = JSON.parse(trimmed) as string;
    } catch {
      value = trimmed;
    }
    if (["system", "user", "assistant", "tool"].includes(value)) return `json-role role-${value}`;
    if (["search_solutions", "analyze_reviews", "compare_pricing"].includes(value))
      return "json-tool-name";
    if (value === "deepseek-chat") return "json-model";
    if (value === "auto") return "json-auto";
    if (trimmed.includes('\\"')) return "json-encoded";
    return "json-string";
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return "json-number";
  if (/^(true|false)$/.test(trimmed)) return "json-boolean";
  if (trimmed === "null") return "json-null";
  return "json-punctuation";
}

function JsonView({ value }: { value: unknown }) {
  const source = JSON.stringify(value, null, 2);
  const tokens = source
    .split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?)/g)
    .filter(Boolean);
  return (
    <pre className="json-view syntax-json">
      {tokens.map((token, index) => (
        <span className={jsonTokenClass(token)} key={`${index}-${token.slice(0, 12)}`}>
          {token}
        </span>
      ))}
    </pre>
  );
}

function parseJsonString(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function compactInput(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.messages)) {
    if (data.tool_name) return { tool_name: data.tool_name, arguments: data.arguments };
    return value;
  }
  const messages = data.messages as Array<Record<string, unknown>>;
  const userMessage = messages.find((message) => message.role === "user")?.content;
  const history = messages
    .filter((message) => message.role === "assistant" || message.role === "tool")
    .map((message) => {
      if (message.role === "assistant") {
        const calls = Array.isArray(message.tool_calls)
          ? (message.tool_calls as Array<Record<string, unknown>>)
          : [];
        return {
          role: "assistant",
          tool_calls: calls
            .map((call) => (call.function as Record<string, unknown> | undefined)?.name)
            .filter(Boolean),
        };
      }
      return {
        role: "tool",
        tool_call_id: message.tool_call_id,
        observation: "[工具结果已写入上下文]",
      };
    });
  const availableTools = Array.isArray(data.tools)
    ? (data.tools as Array<Record<string, unknown>>)
        .map((tool) => (tool.function as Record<string, unknown> | undefined)?.name)
        .filter(Boolean)
    : [];
  return {
    model: data.model,
    system_rule_summary: "自主选择有帮助的工具；证据足够时停止",
    user_message: userMessage,
    ...(history.length ? { history } : {}),
    available_tools: availableTools,
    tool_choice: data.tool_choice,
  };
}

function compactOutput(value: unknown) {
  if (!value || typeof value !== "object") return parseJsonString(value);
  const data = value as Record<string, unknown>;
  if (data.role !== "assistant") return value;
  const calls = Array.isArray(data.tool_calls)
    ? (data.tool_calls as Array<Record<string, unknown>>)
    : [];
  return {
    role: data.role,
    content: data.content || null,
    ...(calls.length
      ? {
          tool_calls: calls.map((call) => {
            const fn = call.function as Record<string, unknown> | undefined;
            return { id: call.id, name: fn?.name, arguments: parseJsonString(fn?.arguments) };
          }),
        }
      : {}),
  };
}

function StepIO({ protocol }: { protocol: ProtocolTrace }) {
  return (
    <details className="step-io">
      <summary>
        <Braces />
        查看精简输入 / 输出
        <ChevronDown />
      </summary>
      <div className="step-io-body">
        <div className="json-legend">
          <span className="role-user">user</span>
          <span className="role-assistant">assistant</span>
          <span className="role-tool">tool</span>
          <span className="json-tool-name">tool name</span>
        </div>
        {protocol.request !== undefined ? (
          <div className="io-block input">
            <span>INPUT · 精简传入</span>
            <JsonView value={compactInput(protocol.request)} />
          </div>
        ) : null}
        {protocol.response !== undefined ? (
          <div className="io-block output">
            <span>OUTPUT · 精简返回</span>
            <JsonView value={compactOutput(protocol.response)} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SelectionAnalysis({ selection }: { selection: ToolSelection }) {
  return (
    <div className="selection-analysis">
      <div className="selection-title">
        <span>EXPERIMENT 01 · 可观察选择</span>
        <strong>{selection.selected.name}</strong>
      </div>
      <p>{selection.selected.description}</p>
      <dl>
        <div>
          <dt>模型公开说明</dt>
          <dd>{selection.model_summary}</dd>
        </div>
        <div>
          <dt>工具顺序</dt>
          <dd>{selection.tool_order.join(" → ")}</dd>
        </div>
        <div>
          <dt>本轮未选择</dt>
          <dd>
            {selection.not_selected_this_round.length
              ? selection.not_selected_this_round.map((item) => item.name).join("、")
              : "无"}
          </dd>
        </div>
      </dl>
      <small>未选择只表示本轮没有返回该工具，不能当作模型隐藏推理的证明。</small>
    </div>
  );
}

function EventCard({
  event,
  index,
  active,
}: {
  event: AgentEvent;
  index: number;
  active: boolean;
}) {
  const Icon =
    event.type === "tool_call"
      ? Wrench
      : event.type === "tool_result"
        ? (toolIcons[event.tool ?? ""] ?? Database)
        : event.type === "final"
          ? Sparkles
          : event.type === "error"
            ? CircleStop
            : Bot;
  return (
    <article className={`trace-card ${event.type} ${active ? "active" : ""}`}>
      <div className="trace-rail">
        <span className="trace-icon">
          <Icon />
        </span>
        <span className="trace-line" />
      </div>
      <div className="trace-body">
        <div className="trace-heading">
          <div>
            <span className="trace-kicker">
              {event.type === "tool_call"
                ? `STEP ${index + 1} · TOOL CALL`
                : event.type === "tool_result"
                  ? `STEP ${index + 1} · TOOL RESULT`
                  : event.type === "final"
                    ? "FINAL · STRUCTURED OUTPUT"
                    : event.type === "error"
                      ? "ERROR"
                      : `STEP ${index + 1} · AGENT`}
            </span>
            <h3>{event.title}</h3>
          </div>
          {event.duration ? (
            <span className="duration">
              <Clock3 /> {event.duration}ms
            </span>
          ) : null}
        </div>
        {event.detail ? <p className="trace-detail">{event.detail}</p> : null}
        {event.selection ? <SelectionAnalysis selection={event.selection} /> : null}
        {event.input ? (
          <div className="payload">
            <span>{event.inputLabel ?? "arguments"}</span>
            <JsonView value={event.input} />
          </div>
        ) : null}
        {event.output !== undefined ? (
          <div className="payload result">
            <span>result</span>
            <JsonView value={event.output} />
          </div>
        ) : null}
        {event.protocol ? <StepIO protocol={event.protocol} /> : null}
      </div>
    </article>
  );
}

export default function Home() {
  const [question, setQuestion] = useState(suggestions[0]);
  const [mode, setMode] = useState<RunMode>("auto");
  const [experimentVariant, setExperimentVariant] = useState<ExperimentVariant>("control");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [result, setResult] = useState<FinalResult | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [manualAction, setManualAction] = useState<ManualAction | null>(null);
  const [manualHistory, setManualHistory] = useState<ToolHistory[]>([]);
  const [manualProposal, setManualProposal] = useState<ToolProposal | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const manualSession = mode === "manual" && manualAction !== null && !result;
  const progress = useMemo(
    () => (running || manualSession ? Math.min(92, 8 + events.length * 8) : result ? 100 : 0),
    [running, manualSession, events.length, result],
  );

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (running || manualSession)
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [events, running, manualSession]);

  async function runAgent() {
    if (!question.trim() || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setEvents([]);
    setResult(null);
    setElapsed(0);
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, includeTaskSpec: false, experimentVariant }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("Agent 服务暂时不可用");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as AgentEvent;
          setEvents((current) => [...current, event]);
          if (event.type === "final" && event.output) setResult(event.output as FinalResult);
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError")
        setEvents((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            type: "error",
            title: "运行中断",
            detail: (error as Error).message,
          },
        ]);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  async function runManualStep(action: ManualAction = "prepare") {
    if (!question.trim() || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    if (!manualSession) {
      setEvents([]);
      setResult(null);
      setElapsed(0);
      setManualHistory([]);
      setManualProposal(null);
    }
    try {
      const response = await fetch("/api/agent/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          action,
          history: manualHistory,
          proposal: manualProposal,
          experimentVariant,
        }),
        signal: controller.signal,
      });
      const payload = (await response.json()) as {
        event?: Omit<AgentEvent, "id">;
        nextAction?: ManualAction | null;
        history?: ToolHistory[];
        proposal?: ToolProposal | null;
        done?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.event) throw new Error(payload.error || "当前步骤执行失败");
      const event = { id: crypto.randomUUID(), ...payload.event } as AgentEvent;
      setEvents((current) => [...current, event]);
      if (event.type === "final" && event.output) setResult(event.output as FinalResult);
      setManualAction(payload.nextAction ?? null);
      if (payload.history) setManualHistory(payload.history);
      setManualProposal(payload.proposal ?? null);
    } catch (error) {
      if ((error as Error).name !== "AbortError")
        setEvents((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            type: "error",
            title: "当前步骤执行失败",
            detail: (error as Error).message,
          },
        ]);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function resetDemo() {
    abortRef.current?.abort();
    setRunning(false);
    setManualAction(null);
    setManualHistory([]);
    setManualProposal(null);
    setEvents([]);
    setResult(null);
    setElapsed(0);
  }
  async function copyResult() {
    if (!result) return;
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool?: (
            tool: unknown,
            options?: { signal?: AbortSignal },
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: "prepare_agent_demo",
          title: "准备 Agent 演示",
          description: "在页面中填写问题，准备可视化 Agent 工具调用循环。",
          inputSchema: {
            type: "object",
            properties: { question: { type: "string", minLength: 3 } },
            required: ["question"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input: unknown) => {
            const value = input as { question?: string };
            if (!value.question?.trim()) throw new Error("question is required");
            setQuestion(value.question.trim());
            return { status: "ready", question: value.question.trim() };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Braces />
          </span>
          <div>
            <strong>Agent Trace</strong>
            <span>实验台</span>
          </div>
        </div>
        <div className="model-pill">
          <span className="live-dot" /> deepseek-chat <ChevronDown />
        </div>
        <div className="top-actions">
          <Badge variant="outline" className="pace-badge">
            {mode === "manual" ? "STEP MODE" : "AUTO MODE"}
          </Badge>
          <Badge variant="outline" className="env-badge">
            LIVE API
          </Badge>
          <button className="icon-button" onClick={resetDemo} aria-label="重置演示">
            <RotateCcw />
          </button>
        </div>
      </header>
      <section className="workspace">
        <aside className="prompt-panel">
          <div className="panel-title">
            <span>01</span>
            <div>
              <h2>设置任务</h2>
              <p>输入问题，选择运行方式</p>
            </div>
          </div>
          <div className="mode-picker">
            <span className="section-label">运行方式</span>
            <Tabs
              value={mode}
              onValueChange={(value) => {
                setMode(value as RunMode);
                resetDemo();
              }}
            >
              <TabsList className="mode-tabs">
                <TabsTrigger value="auto" disabled={running || manualSession}>
                  <Zap />
                  自动运行
                </TabsTrigger>
                <TabsTrigger value="manual" disabled={running || manualSession}>
                  <Hand />
                  分步确认
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <p>
              {mode === "auto"
                ? "自动完成完整 ReAct 循环。"
                : "组装输入、模型返回、工具执行都逐步确认。"}
            </p>
          </div>
          <div className="prompt-card">
            <label htmlFor="question">用户问题</label>
            <Textarea
              id="question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              disabled={running || manualSession}
              className="prompt-input"
              rows={7}
            />
            <div className="prompt-meta">
              <span>{question.length} 字符</span>
              <span>{mode === "manual" ? "逐步确认" : "自动执行"}</span>
            </div>
          </div>
          <div className="run-area">
            <Button
              onClick={
                running
                  ? () => abortRef.current?.abort()
                  : mode === "auto"
                    ? runAgent
                    : () => runManualStep(manualAction ?? "prepare")
              }
              className={`run-button ${running ? "stop" : ""}`}
            >
              {running ? (
                <>
                  <CircleStop /> 停止当前步骤
                </>
              ) : mode === "manual" ? (
                manualSession ? (
                  manualAction === "execute" ? (
                    <>
                      <Check />
                      批准并执行工具
                    </>
                  ) : manualAction === "decide" ? (
                    <>
                      <StepForward />
                      发送给 DeepSeek
                    </>
                  ) : (
                    <>
                      <StepForward />
                      准备下一轮输入
                    </>
                  )
                ) : (
                  <>
                    <Play fill="currentColor" /> 开始分步运行
                  </>
                )
              ) : (
                <>
                  <Play fill="currentColor" /> 自动运行 ReAct
                </>
              )}
            </Button>
            <p>
              <FlaskConical /> 工具结果为预设数据，工具选择和参数由模型决定
            </p>
          </div>
          <div className="experiment-panel">
            <div className="experiment-heading">
              <span className="section-label">实验一 · 工具选择</span>
              <Badge variant="outline">单变量</Badge>
            </div>
            <RadioGroup
              value={experimentVariant}
              onValueChange={(value) => {
                setExperimentVariant(value as ExperimentVariant);
                resetDemo();
              }}
              disabled={running || manualSession}
            >
              {experimentOptions.map((option) => (
                <label
                  key={option.value}
                  className={`experiment-option ${experimentVariant === option.value ? "selected" : ""}`}
                >
                  <RadioGroupItem value={option.value} />
                  <span>
                    <strong>{option.title}</strong>
                    <small>{option.detail}</small>
                  </span>
                </label>
              ))}
            </RadioGroup>
            <p>改变工具描述和顺序，观察相同问题下 DeepSeek 返回哪个 tool_call。</p>
          </div>
          <div className="suggestions">
            <span className="section-label">试试这些问题 · {suggestions.length}</span>
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion}
                onClick={() => setQuestion(suggestion)}
                disabled={running || manualSession}
              >
                <span>0{index + 1}</span>
                {suggestion}
                <ArrowUp />
              </button>
            ))}
          </div>
        </aside>
        <section className="trace-panel">
          <div className="trace-header">
            <div className="panel-title">
              <span>02</span>
              <div>
                <h2>执行轨迹</h2>
                <p>观察模型如何选择工具、使用结果并继续判断</p>
              </div>
            </div>
            <div className="run-stats">
              <span>{events.filter((event) => event.type === "tool_call").length} tools</span>
              <span>{mode === "manual" ? `${events.length} steps` : `${elapsed.toFixed(1)}s`}</span>
            </div>
          </div>
          <Progress value={progress} className="trace-progress" />
          <div className="trace-scroll" ref={scrollRef}>
            {events.length ? (
              events.map((event, index) => (
                <EventCard
                  key={event.id}
                  event={event}
                  index={index}
                  active={(running || manualSession) && index === events.length - 1}
                />
              ))
            ) : (
              <div className="empty-trace">
                <Bot />
                <h3>从一个问题开始</h3>
                <p>运行后，这里会按时间顺序展示可观察的 ReAct 循环。</p>
                <div className="empty-flow" aria-label="ReAct 循环步骤">
                  <span>模型决策</span>
                  <span>工具调用</span>
                  <span>观察结果</span>
                  <span>继续判断</span>
                </div>
              </div>
            )}
            {running ? (
              <div className="thinking-row">
                <span />
                <span />
                <span />
                <em>
                  {mode === "manual" && (manualAction === null || manualAction === "prepare")
                    ? "正在组装下一轮输入"
                    : "DeepSeek 正在决定下一步"}
                </em>
              </div>
            ) : null}
            {manualSession && !running ? (
              <div className="manual-gate">
                <span className="gate-icon">
                  <Hand />
                </span>
                <div>
                  <strong>
                    {manualAction === "execute"
                      ? "等待批准工具调用"
                      : manualAction === "decide"
                        ? "模型输入已经准备好"
                        : "准备进入下一轮"}
                  </strong>
                  <p>
                    {manualAction === "execute"
                      ? "检查模型返回的参数后批准执行。"
                      : manualAction === "decide"
                        ? "此时还没有 query；点击后才会发送给 DeepSeek。"
                        : "先组装本轮要发送的问题、Observation 和工具定义。"}
                  </p>
                </div>
                <Button onClick={() => runManualStep(manualAction)} size="sm">
                  {manualAction === "execute" ? (
                    <>
                      <Check />
                      批准并执行
                    </>
                  ) : manualAction === "decide" ? (
                    <>
                      <StepForward />
                      发送给 DeepSeek
                    </>
                  ) : (
                    <>
                      <StepForward />
                      准备下一轮
                    </>
                  )}
                </Button>
              </div>
            ) : null}
          </div>
        </section>
        <aside className="output-panel">
          <div className="output-header">
            <div className="panel-title">
              <span>03</span>
              <div>
                <h2>结论与证据</h2>
                <p>循环结束后生成结构化建议</p>
              </div>
            </div>
            <button
              className="icon-button"
              onClick={copyResult}
              disabled={!result}
              aria-label="复制 JSON"
            >
              {copied ? <Check /> : <Copy />}
            </button>
          </div>
          {result ? (
            <div className="result-stack">
              <div className="result-block primary-result">
                <span>RECOMMENDATION</span>
                <h3>{result.recommendation}</h3>
              </div>
              <div className="result-block">
                <span>SUMMARY</span>
                <p>{result.summary}</p>
              </div>
              <div className="result-block">
                <span>EVIDENCE</span>
                <ul>
                  {result.evidence.map((item) => (
                    <li key={item}>
                      <Check />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="result-grid">
                <div className="result-block compact">
                  <span>RISKS</span>
                  <strong>{result.risks.length}</strong>
                  <small>项待验证</small>
                </div>
                <div className="result-block compact">
                  <span>NEXT STEPS</span>
                  <strong>{result.next_steps.length}</strong>
                  <small>个后续动作</small>
                </div>
              </div>
              <details className="raw-json">
                <summary>
                  <Braces /> 查看原始 JSON <ChevronDown />
                </summary>
                <JsonView value={result} />
              </details>
            </div>
          ) : (
            <div className="empty-output">
              <Sparkles />
              <h3>{running ? "正在汇总证据" : "等待运行结果"}</h3>
              <p>工具循环结束后，结构化结果会在这里生成。</p>
            </div>
          )}
          <footer className="output-footer">
            <span className={result ? "ready-dot" : ""} /> Schema validated <code>v1.0</code>
          </footer>
        </aside>
      </section>
    </main>
  );
}
