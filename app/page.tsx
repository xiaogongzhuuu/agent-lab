"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Braces,
  Check,
  ChevronDown,
  CircleStop,
  Copy,
  FlaskConical,
  Play,
  RotateCcw,
  Sparkles,
  StepForward,
  Wrench,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

type RunMode = "auto" | "manual";
type ManualAction = "prepare" | "decide" | "execute";
type ExperimentVariant = "control" | "ambiguous" | "budget_first";
type ToolName = "search_solutions" | "analyze_reviews" | "compare_pricing";
type ToolProposal = { callId: string; name: ToolName; arguments: Record<string, unknown> };
type ToolHistory = ToolProposal & { result: unknown };
type FinalResult = {
  summary: string;
  recommendation: string;
  evidence: string[];
  risks: string[];
  next_steps: string[];
};
type ProtocolTrace = {
  request?: unknown;
  response?: unknown;
  parsed?: unknown;
  messageAppend?: unknown;
  note?: string;
};
type ToolSelection = {
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
  input?: unknown;
  output?: unknown;
  protocol?: ProtocolTrace;
  selection?: ToolSelection;
  decision?: { reason?: string };
};

const examples = [
  "帮我为 10 人产品团队选择 AI 知识库方案，预算每月 1500 元",
  "10 人产品团队预算降到每月 800 元，优先考虑上手快和低维护",
  "比较 Notion AI、Guru 和 Slite，给出适合 10 人初创团队的建议",
  "团队主要使用 Slack 和 Jira，哪种 AI 知识库集成体验更合适",
  "我们有复杂的文档权限，预算每月 1500 元，应该选哪个方案",
  "需要从旧文档库迁移 500 篇资料，请评估方案和迁移风险",
  "按 10 个席位计算半年总成本，并给出性价比最高的选择",
  "重点分析候选方案的差评和潜在风险，再给出保守建议",
];

const experimentOptions: Array<{
  value: ExperimentVariant;
  title: string;
  description: string;
}> = [
  { value: "control", title: "清晰职责", description: "候选、评价、价格各有分工" },
  { value: "ambiguous", title: "模糊描述", description: "三个工具的描述相同" },
  { value: "budget_first", title: "预算优先", description: "价格工具排在首位" },
];

function TraceMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M8 9h9a6 6 0 0 1 0 12H8"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="9" r="3" fill="currentColor" />
      <circle cx="23" cy="15" r="3" fill="currentColor" />
      <circle cx="8" cy="21" r="3" fill="#7be4bd" />
    </svg>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="event-payload">
      <span>{label}</span>
      <pre className="json-view">{JSON.stringify(value, null, 2) ?? String(value)}</pre>
    </div>
  );
}

function EventCard({ event, index }: { event: AgentEvent; index: number }) {
  const eventLabel = {
    status: "模型步骤",
    tool_call: "工具调用",
    tool_result: "观察结果",
    final: "最终输出",
    error: "运行错误",
  }[event.type];
  const Icon =
    event.type === "tool_call"
      ? Wrench
      : event.type === "final"
        ? Sparkles
        : event.type === "error"
          ? CircleStop
          : event.type === "tool_result"
            ? Check
            : Braces;
  const protocol = event.protocol;
  const hasProtocol =
    protocol &&
    (protocol.request !== undefined ||
      protocol.response !== undefined ||
      protocol.parsed !== undefined ||
      protocol.messageAppend !== undefined);

  return (
    <article className={`trace-event trace-event--${event.type}`}>
      <span className="event-marker" aria-hidden="true">
        <Icon size={17} />
      </span>
      <div className="event-content">
        <div className="event-header">
          <span className="event-type">
            {String(index + 1).padStart(2, "0")} · {eventLabel}
          </span>
          {event.tool ? <code>{event.tool}</code> : null}
        </div>
        <h3>{event.title}</h3>
        {event.detail ? <p className="event-detail">{event.detail}</p> : null}
        {event.title === "DeepSeek 决定停止调用工具" && event.decision?.reason ? (
          <p className="event-detail">模型说明：{event.decision.reason}</p>
        ) : null}
        {event.selection ? (
          <div className="selection-analysis">
            <strong>本轮选择：{event.selection.selected.name}</strong>
            {event.selection.selected.description ? (
              <p>{event.selection.selected.description}</p>
            ) : null}
            <p>{event.selection.model_summary}</p>
            <small>可用顺序：{event.selection.tool_order.join(" → ")}</small>
            {event.selection.not_selected_this_round.length ? (
              <small>
                本轮未选：
                {event.selection.not_selected_this_round.map((item) => item.name).join("、")}
              </small>
            ) : null}
          </div>
        ) : null}
        {event.input !== undefined ? <JsonBlock label="输入" value={event.input} /> : null}
        {event.output !== undefined && event.type !== "final" ? (
          <JsonBlock label="Observation" value={event.output} />
        ) : null}
        {hasProtocol ? (
          <details className="event-details">
            <summary>
              查看请求与响应 <ChevronDown size={15} />
            </summary>
            <div>
              {protocol.request !== undefined ? (
                <JsonBlock
                  label={event.type === "tool_result" ? "Tool Request" : "Model Request"}
                  value={protocol.request}
                />
              ) : null}
              {protocol.response !== undefined ? (
                <JsonBlock
                  label={event.type === "tool_result" ? "Tool Response" : "Model Response"}
                  value={protocol.response}
                />
              ) : null}
              {protocol.parsed !== undefined ? (
                <JsonBlock label="解析结果" value={protocol.parsed} />
              ) : null}
              {protocol.messageAppend !== undefined ? (
                <JsonBlock label="写入下一轮上下文" value={protocol.messageAppend} />
              ) : null}
              {protocol.note ? <p className="helper-text">{protocol.note}</p> : null}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}

function ResultPanel({
  result,
  onCopy,
  copied,
}: {
  result: FinalResult;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <section className="result-panel" aria-label="最终结论">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">最终结果</span>
          <h2>结论与证据</h2>
        </div>
        <Button variant="outline" size="sm" onClick={onCopy}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "已复制" : "复制 JSON"}
        </Button>
      </div>
      <div className="result-lead">
        <span>建议</span>
        <p>{result.recommendation}</p>
      </div>
      <p className="result-summary">{result.summary}</p>
      <div className="result-grid">
        <div className="result-section">
          <h3>证据</h3>
          <ul>
            {result.evidence.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="result-section">
          <h3>风险与后续</h3>
          <ul>
            {result.risks.map((item, index) => (
              <li key={`risk-${index}-${item}`}>{item}</li>
            ))}
          </ul>
          <h3>下一步</h3>
          <ul>
            {result.next_steps.map((item, index) => (
              <li key={`next-${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
      <details className="event-details">
        <summary>
          查看原始 JSON <ChevronDown size={15} />
        </summary>
        <JsonBlock label="Final JSON" value={result} />
      </details>
    </section>
  );
}

export default function Home() {
  const [question, setQuestion] = useState(examples[0]);
  const [mode, setMode] = useState<RunMode>("auto");
  const [experimentVariant, setExperimentVariant] = useState<ExperimentVariant>("control");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [result, setResult] = useState<FinalResult | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  const [manualAction, setManualAction] = useState<ManualAction | null>(null);
  const [manualHistory, setManualHistory] = useState<ToolHistory[]>([]);
  const [manualProposal, setManualProposal] = useState<ToolProposal | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const traceRef = useRef<HTMLDivElement>(null);
  const manualSession = mode === "manual" && manualAction !== null && !result;
  const toolCount = useMemo(
    () => events.filter((event) => event.type === "tool_call").length,
    [events],
  );
  const progress =
    running || manualSession ? Math.min(92, 8 + events.length * 8) : result ? 100 : 0;

  useEffect(() => {
    if (!running) return;
    const start = Date.now() - elapsed * 1000;
    const timer = window.setInterval(() => setElapsed((Date.now() - start) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (running || manualSession)
      traceRef.current?.scrollTo({ top: traceRef.current.scrollHeight, behavior: "smooth" });
  }, [events, running, manualSession]);

  function resetRun() {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setEvents([]);
    setResult(null);
    setElapsed(0);
    setManualAction(null);
    setManualHistory([]);
    setManualProposal(null);
  }

  function appendError(error: unknown, runId: number) {
    if (runId !== runIdRef.current) return;
    if (error instanceof Error && error.name === "AbortError") return;
    setEvents((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        type: "error",
        title: "运行中断",
        detail: error instanceof Error ? error.message : "未知错误",
      },
    ]);
  }

  async function runAuto() {
    if (!question.trim() || running) return;
    resetRun();
    const runId = runIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: question.trim(),
          includeTaskSpec: false,
          experimentVariant,
        }),
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
          if (runId !== runIdRef.current) return;
          if (!line.trim()) continue;
          const event = JSON.parse(line) as AgentEvent;
          setEvents((current) => [...current, event]);
          if (event.type === "final") setResult(event.output as FinalResult);
        }
      }
    } catch (error) {
      appendError(error, runId);
    } finally {
      if (runId === runIdRef.current) {
        setRunning(false);
        abortRef.current = null;
      }
    }
  }

  async function runManual(action: ManualAction = manualAction ?? "prepare") {
    if (!question.trim() || running) return;
    if (!manualSession) resetRun();
    const runId = runIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    try {
      const response = await fetch("/api/agent/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: question.trim(),
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
        error?: string;
      };
      if (runId !== runIdRef.current) return;
      if (!response.ok || !payload.event) throw new Error(payload.error || "当前步骤执行失败");
      const event = { id: crypto.randomUUID(), ...payload.event } as AgentEvent;
      setEvents((current) => [...current, event]);
      if (event.type === "final") setResult(event.output as FinalResult);
      setManualAction(payload.nextAction ?? null);
      setManualHistory(payload.history ?? []);
      setManualProposal(payload.proposal ?? null);
    } catch (error) {
      appendError(error, runId);
    } finally {
      if (runId === runIdRef.current) {
        setRunning(false);
        abortRef.current = null;
      }
    }
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

  const manualButtonText =
    manualAction === "execute"
      ? "批准并执行工具"
      : manualAction === "decide"
        ? "发送给 DeepSeek"
        : manualAction === "prepare"
          ? "准备下一轮输入"
          : "开始分步运行";
  const runningText =
    mode === "manual" && manualAction === "execute"
      ? "正在执行演示工具…"
      : mode === "manual" && (manualAction === null || manualAction === "prepare")
        ? "正在准备模型输入…"
        : "DeepSeek 正在决定下一步…";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <TraceMark />
          </span>
          <div>
            <strong>Agent 调用可视化平台</strong>
            <span>工具调用与 ReAct 轨迹</span>
          </div>
        </div>
        <div className="topbar-meta">
          <span>deepseek-chat</span>
          <span>工具结果为演示数据</span>
        </div>
        <button className="reset-button" onClick={resetRun} aria-label="重置演示" title="重置演示">
          <RotateCcw size={17} />
        </button>
      </header>

      <div className="workspace">
        <aside className="setup-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">01 / SETUP</span>
              <h1>设置任务</h1>
            </div>
          </div>
          <div className="mode-picker">
            <span className="field-label">运行方式</span>
            <Tabs
              value={mode}
              onValueChange={(value) => {
                setMode(value as RunMode);
                resetRun();
              }}
            >
              <TabsList className="mode-tabs">
                <TabsTrigger value="auto" disabled={running || manualSession}>
                  <Zap size={15} /> 自动运行
                </TabsTrigger>
                <TabsTrigger value="manual" disabled={running || manualSession}>
                  <StepForward size={15} /> 分步确认
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="question-card">
            <label className="field-label" htmlFor="question">
              用户问题
            </label>
            <Textarea
              id="question"
              className="prompt-input"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              disabled={running || manualSession}
              rows={5}
            />
          </div>
          <Button
            className={`run-button ${running ? "run-button--stop" : ""}`}
            onClick={
              running
                ? () => abortRef.current?.abort()
                : mode === "auto"
                  ? runAuto
                  : () => runManual()
            }
            disabled={!running && !question.trim()}
          >
            {running ? (
              <>
                <CircleStop size={17} /> 停止
              </>
            ) : mode === "manual" ? (
              <>
                <Play size={17} /> {manualButtonText}
              </>
            ) : (
              <>
                <Play size={17} /> 运行 ReAct 循环
              </>
            )}
          </Button>
          <p className="helper-text">工具选择和参数由模型生成；工具结果来自预设数据。</p>

          <details className="experiment" open>
            <summary>
              <FlaskConical size={17} /> 工具选择实验 <ChevronDown size={16} />
            </summary>
            <p>切换描述与顺序，比较模型在相同问题下的选择。</p>
            <RadioGroup
              className="experiment-options"
              value={experimentVariant}
              onValueChange={(value) => {
                setExperimentVariant(value as ExperimentVariant);
                resetRun();
              }}
              disabled={running || manualSession}
            >
              {experimentOptions.map((option) => (
                <label
                  className={`experiment-option ${experimentVariant === option.value ? "is-selected" : ""}`}
                  key={option.value}
                >
                  <RadioGroupItem value={option.value} />
                  <span>
                    <strong>{option.title}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </details>
          <details className="examples">
            <summary>
              试试这些问题 <span>{examples.length}</span>
              <ChevronDown size={16} />
            </summary>
            <div className="examples-list">
              {examples.map((example, index) => (
                <button
                  key={example}
                  onClick={() => setQuestion(example)}
                  disabled={running || manualSession}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {example}
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
          </details>
        </aside>

        <section className="content-panel">
          <div className="trace-header">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">02 / TRACE</span>
                <h2>执行轨迹</h2>
              </div>
            </div>
            <div className="run-stats">
              <span>{toolCount} 次工具调用</span>
              <span>{mode === "manual" ? `${events.length} 步` : `${elapsed.toFixed(1)} 秒`}</span>
            </div>
          </div>
          <Progress className="trace-progress" value={progress} />
          <div
            className={`trace-list ${running && !events.length ? "trace-list--pending" : ""}`}
            ref={traceRef}
            aria-live="polite"
          >
            {events.length ? (
              events.map((event, index) => <EventCard key={event.id} event={event} index={index} />)
            ) : running ? (
              <div className="pending-state">
                <span className="pending-indicator" aria-hidden="true" />
                <div>
                  <strong>正在建立执行轨迹</strong>
                  <p>{runningText}</p>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <span>
                  <TraceMark size={26} />
                </span>
                <h3>运行后查看每一步</h3>
                <p>模型请求 → 工具调用 → Observation → 下一轮决策</p>
              </div>
            )}
            {running && events.length > 0 ? <p className="running-message">{runningText}</p> : null}
            {manualSession && !running ? (
              <div className="manual-gate">
                <strong>
                  {manualAction === "execute"
                    ? "工具尚未执行"
                    : manualAction === "decide"
                      ? "模型输入已准备"
                      : "准备下一轮"}
                </strong>
                <p>
                  {manualAction === "execute"
                    ? "检查上方参数后继续。"
                    : "点击继续，查看下一步的可观察结果。"}
                </p>
                <Button size="sm" onClick={() => runManual()}>
                  {manualButtonText}
                </Button>
              </div>
            ) : null}
          </div>
          {result ? <ResultPanel result={result} onCopy={copyResult} copied={copied} /> : null}
          {!running ? (
            <p className="footer-note">只展示 API 返回的可观察内容，不包含模型内部隐藏思维过程。</p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
