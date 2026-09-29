"use client";

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArchitectureDiagram } from "./components/architecture-diagram";
import { TraceFields, TraceInspector, type TraceSelection } from "./components/trace-fields";
import { buildTraceLinks, type TraceEvent as AgentEvent } from "@/lib/trace-links";
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Workflow,
} from "lucide-react";

type ToolDraft = { id: string; name: string; description: string; resultText: string };
type ModelEvent = Extract<AgentEvent, { type: "model" }>;
type ToolEvent = Extract<AgentEvent, { type: "tool" }>;
type Architecture = "react" | "fixed" | "plan";
type Example = "basic" | "conditional" | "custom";
type RunRecord = {
  events: AgentEvent[];
  status: "running" | "complete" | "error" | "stopped";
  durationMs: number | null;
};

const architectures: Architecture[] = ["react", "fixed", "plan"];
const architectureNames: Record<Architecture, string> = {
  react: "ReAct 循环",
  fixed: "固定流程",
  plan: "先计划后执行",
};
const emptyRuns = (): Record<Architecture, RunRecord | null> => ({
  react: null,
  fixed: null,
  plan: null,
});
const basicQuery = "先调用 a，拿到结果后再调用 b，最后总结。";
const conditionalQuery =
  "先调用 a；仅当 a 返回的 need_b 为 true 时，再调用 b。最后根据实际结果总结。";

const architectureNotes: Record<Architecture, string> = {
  react: "每轮一个工具，观察后再决定；工具不重复。",
  fixed: "按工具列表顺序，执行任务中点名的工具。",
  plan: "模型先列出步骤，再依次执行。",
};

const modules = [
  { name: "工具调用", icon: Workflow, current: true },
  { name: "上下文压缩", icon: Minimize2, current: false },
  { name: "长期记忆", icon: Brain, current: false },
] as const;

const sidebarPreferenceKey = "agent-lab.sidebar-collapsed";
const sidebarListeners = new Set<() => void>();
let sidebarPreference: boolean | undefined;

function readSidebarPreference() {
  if (sidebarPreference === undefined) {
    try {
      sidebarPreference = localStorage.getItem(sidebarPreferenceKey) === "true";
    } catch {
      sidebarPreference = false;
    }
  }
  return sidebarPreference;
}

function subscribeSidebarPreference(listener: () => void) {
  sidebarListeners.add(listener);
  return () => {
    sidebarListeners.delete(listener);
  };
}

function saveSidebarPreference(collapsed: boolean) {
  sidebarPreference = collapsed;
  try {
    localStorage.setItem(sidebarPreferenceKey, String(collapsed));
  } catch {
    // Keep the choice in memory when browser storage is unavailable.
  }
  sidebarListeners.forEach((listener) => listener());
}

const initialTools: ToolDraft[] = [
  { id: "a", name: "a", description: "用户要求调用 a 时使用", resultText: '{"value":"A 的结果"}' },
  { id: "b", name: "b", description: "用户要求调用 b 时使用", resultText: '{"value":"B 的结果"}' },
  { id: "c", name: "c", description: "用户要求调用 c 时使用", resultText: '{"value":"C 的结果"}' },
];

function conditionalTools(needsB: boolean): ToolDraft[] {
  return [
    {
      id: "a",
      name: "a",
      description: "先检查是否需要调用 b，返回 need_b",
      resultText: JSON.stringify({ need_b: needsB, value: needsB ? "需要 b" : "无需 b" }),
    },
    {
      id: "b",
      name: "b",
      description: "仅当 a 的 need_b 为 true 时使用",
      resultText: '{"value":"B 的结果"}',
    },
    { ...initialTools[2] },
  ];
}

function modelCalls(events: AgentEvent[]) {
  return events.filter(
    (event) => event.type === "model" || (event.type === "plan" && event.source === "model"),
  ).length;
}

function calledTools(events: AgentEvent[]) {
  return events
    .filter((event): event is ToolEvent => event.type === "tool")
    .map((event) => event.name);
}

function formatDuration(ms: number | null) {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="json-panel">
      <div className="json-panel-title">{title}</div>
      <pre>{JSON.stringify(value, null, 2) ?? String(value)}</pre>
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function modelSummary(event: ModelEvent) {
  const request = asRecord(event.request);
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const userMessage = messages.find((message) => asRecord(message)?.role === "user");
  const query = asRecord(userMessage)?.content;
  const previousTools = messages
    .filter((message) => asRecord(message)?.role === "assistant")
    .flatMap((message) => {
      const calls = asRecord(message)?.tool_calls;
      return Array.isArray(calls)
        ? calls
            .map((call) => asRecord(asRecord(call)?.function)?.name)
            .filter((name): name is string => typeof name === "string")
        : [];
    });
  const availableTools = Array.isArray(request?.tools)
    ? request.tools
        .map((tool) => asRecord(asRecord(tool)?.function)?.name)
        .filter((name): name is string => typeof name === "string")
    : [];
  const response = asRecord(event.response);
  const choices = Array.isArray(response?.choices) ? response.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const calledTools = calls
    .map((call) => asRecord(asRecord(call)?.function)?.name)
    .filter((name): name is string => typeof name === "string");
  return {
    query,
    previousTools: event.used_tools ?? previousTools,
    availableTools,
    calledTools,
  };
}

function RawDetails({ children }: { children: ReactNode }) {
  return (
    <details className="raw-details">
      <summary>查看完整 JSON</summary>
      {children}
    </details>
  );
}

export default function Home() {
  const [query, setQuery] = useState(basicQuery);
  const [architecture, setArchitecture] = useState<Architecture>("react");
  const [tools, setTools] = useState<ToolDraft[]>(initialTools);
  const [example, setExample] = useState<Example>("basic");
  const [needsB, setNeedsB] = useState(false);
  const [runs, setRuns] = useState<Record<Architecture, RunRecord | null>>(emptyRuns);
  const [running, setRunning] = useState(false);
  const [runningMode, setRunningMode] = useState<Architecture | null>(null);
  const [inputError, setInputError] = useState("");
  const sidebarCollapsed = useSyncExternalStore(
    subscribeSidebarPreference,
    readSidebarPreference,
    () => false,
  );
  const [setupCollapsed, setSetupCollapsed] = useState(false);
  const [inspection, setInspection] = useState<{
    architecture: Architecture;
    selection: TraceSelection;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);

  function toggleSidebar() {
    saveSidebarPreference(!sidebarCollapsed);
  }

  function updateTool(id: string, field: "name" | "description" | "resultText", value: string) {
    setTools((current) =>
      current.map((tool) => (tool.id === id ? { ...tool, [field]: value } : tool)),
    );
    setExample("custom");
    setRuns(emptyRuns());
  }

  function loadExample(next: "basic" | "conditional") {
    setExample(next);
    setNeedsB(false);
    setQuery(next === "basic" ? basicQuery : conditionalQuery);
    setTools(
      next === "basic" ? initialTools.map((tool) => ({ ...tool })) : conditionalTools(false),
    );
    setRuns(emptyRuns());
    setInputError("");
  }

  function changeCondition(value: boolean) {
    setNeedsB(value);
    setTools((current) =>
      current.map((tool) =>
        tool.id === "a"
          ? {
              ...tool,
              resultText: JSON.stringify({ need_b: value, value: value ? "需要 b" : "无需 b" }),
            }
          : tool,
      ),
    );
    setRuns(emptyRuns());
  }

  function resetTrace() {
    setInspection(null);
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setRunningMode(null);
    setRuns(emptyRuns());
    setInputError("");
  }

  async function runModes(modes: Architecture[]) {
    setInspection(null);
    if (running) return;
    setInputError("");
    let configuredTools: Array<{ name: string; description: string; result: unknown }>;
    try {
      configuredTools = tools.map((tool) => ({
        name: tool.name.trim(),
        description: tool.description.trim(),
        result: JSON.parse(tool.resultText),
      }));
    } catch {
      setInputError("工具返回值必须是有效 JSON");
      return;
    }
    if (!query.trim()) {
      setInputError("请输入任务");
      return;
    }
    if (new Set(configuredTools.map((tool) => tool.name)).size !== configuredTools.length) {
      setInputError("工具名称不能重复");
      return;
    }
    runIdRef.current += 1;
    const runId = runIdRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    if (modes.length > 1) setRuns(emptyRuns());
    try {
      for (const mode of modes) {
        if (controller.signal.aborted || runId !== runIdRef.current) break;
        const started = performance.now();
        const received: AgentEvent[] = [];
        let status: RunRecord["status"] = "running";
        setArchitecture(mode);
        setRunningMode(mode);
        setRuns((current) => ({
          ...current,
          [mode]: { events: [], status: "running", durationMs: null },
        }));
        const addEvent = (event: AgentEvent) => {
          received.push(event);
          if (event.type === "error") status = "error";
          setRuns((current) => ({
            ...current,
            [mode]: { events: [...received], status: "running", durationMs: null },
          }));
        };
        try {
          const response = await fetch("/api/agent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: query.trim(),
              tools: configuredTools,
              architecture: mode,
            }),
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            const payload = (await response.json()) as { error?: string };
            throw new Error(payload.error || "Agent 服务不可用");
          }
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
              if (line.trim()) addEvent(JSON.parse(line) as AgentEvent);
            }
          }
          if (buffer.trim() && runId === runIdRef.current) {
            addEvent(JSON.parse(buffer) as AgentEvent);
          }
          if (status === "running") status = "complete";
        } catch (error) {
          status = controller.signal.aborted ? "stopped" : "error";
          if (status === "error" && runId === runIdRef.current) {
            addEvent({
              type: "error",
              message: error instanceof Error ? error.message : "运行失败",
            });
          }
        } finally {
          if (runId === runIdRef.current) {
            setRuns((current) => ({
              ...current,
              [mode]: {
                events: [...received],
                status,
                durationMs: performance.now() - started,
              },
            }));
          }
        }
        if (controller.signal.aborted) break;
      }
    } finally {
      if (runId === runIdRef.current) {
        setRunning(false);
        setRunningMode(null);
        abortRef.current = null;
      }
    }
  }

  const selectedRun = runs[architecture];
  const events = selectedRun?.events ?? [];
  const modelCount = modelCalls(events);
  const toolCount = calledTools(events).length;
  const hasRuns = architectures.some((mode) => runs[mode] !== null);
  const traceLinks = buildTraceLinks(events);
  const inspectionEvents = inspection ? (runs[inspection.architecture]?.events ?? []) : [];
  const inspectionLinks = inspection ? buildTraceLinks(inspectionEvents) : [];

  function inspectField(selection: TraceSelection) {
    setInspection({ architecture, selection });
  }

  function locateTrace(index: number) {
    if (!inspection) return;
    const mode = inspection.architecture;
    setArchitecture(mode);
    requestAnimationFrame(() => {
      const target = document.getElementById(`trace-${mode}-${index}`);
      const details = target?.querySelector("details.raw-details");
      if (details instanceof HTMLDetailsElement) details.open = true;
      target?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
      target?.focus({ preventScroll: true });
    });
  }

  return (
    <main className="app">
      <header className="header">
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={sidebarCollapsed ? "展开功能栏" : "收起功能栏"}
          aria-expanded={!sidebarCollapsed}
          aria-controls="module-navigation"
          title={sidebarCollapsed ? "展开功能栏" : "收起功能栏"}
          onClick={toggleSidebar}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
        </button>
        <div className="brand-mark" aria-hidden="true">
          ↻
        </div>
        <div>
          <strong>Agent 最小实验台</strong>
          <span>观察不同架构的调用过程</span>
        </div>
        <span className="model-badge">deepseek-chat</span>
      </header>

      <div className={`workspace${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
        <nav className="module-sidebar" aria-label="功能导航" id="module-navigation">
          <span className="module-sidebar-label">功能模块</span>
          <div className="module-nav">
            {modules.map((module) => {
              const Icon = module.icon;
              return (
                <button
                  className={`module-item${module.current ? " active" : " planned"}`}
                  type="button"
                  key={module.name}
                  aria-current={module.current ? "page" : undefined}
                  aria-label={module.current ? module.name : `${module.name}，规划中`}
                  title={module.current ? module.name : `${module.name} · 规划中`}
                  disabled={!module.current}
                  onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
                >
                  <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                  <span className="module-name">{module.name}</span>
                  {!module.current ? <small>规划中</small> : null}
                </button>
              );
            })}
          </div>
        </nav>
        <div className={`layout${setupCollapsed ? " setup-collapsed" : ""}`}>
          <aside className="setup">
            <div className="section-title setup-heading">
              <h1>任务与工具</h1>
              <button
                className="sidebar-toggle setup-toggle"
                type="button"
                aria-label={setupCollapsed ? "展开任务配置" : "收起任务配置"}
                aria-expanded={!setupCollapsed}
                aria-controls="setup-fields"
                title={setupCollapsed ? "展开任务配置" : "收起任务配置"}
                onClick={() => setSetupCollapsed((value) => !value)}
              >
                {setupCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
                <span className="setup-toggle-label" aria-hidden="true">
                  任务配置
                </span>
              </button>
            </div>
            <div id="setup-fields" hidden={setupCollapsed}>
              <div className="example-picker" aria-label="示例任务">
                <span>示例</span>
                <button
                  type="button"
                  className={example === "basic" ? "selected" : ""}
                  onClick={() => loadExample("basic")}
                  disabled={running}
                >
                  基础
                </button>
                <button
                  type="button"
                  className={example === "conditional" ? "selected" : ""}
                  onClick={() => loadExample("conditional")}
                  disabled={running}
                >
                  条件任务
                </button>
              </div>
              <label className="field">
                <span>任务</span>
                <textarea
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setExample("custom");
                    setRuns(emptyRuns());
                  }}
                  disabled={running}
                  rows={4}
                />
              </label>
              {example === "conditional" ? (
                <label className="field condition-field">
                  <span>a 的返回结果</span>
                  <select
                    value={needsB ? "true" : "false"}
                    onChange={(event) => changeCondition(event.target.value === "true")}
                    disabled={running}
                  >
                    <option value="false">不需要调用 b</option>
                    <option value="true">需要调用 b</option>
                  </select>
                  <small>ReAct 会看结果再决定；其他架构先定步骤。</small>
                </label>
              ) : null}
              <label className="field architecture-field">
                <span>架构</span>
                <select
                  value={architecture}
                  onChange={(event) => setArchitecture(event.target.value as Architecture)}
                  disabled={running}
                >
                  <option value="react">ReAct 循环</option>
                  <option value="fixed">固定流程</option>
                  <option value="plan">先计划后执行</option>
                </select>
                <small>{architectureNotes[architecture]}</small>
              </label>
              <div className="setup-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => runModes([architecture])}
                  disabled={running}
                >
                  {running
                    ? `运行中：${architectureNames[runningMode ?? architecture]}`
                    : "运行当前架构"}
                </button>
                <button
                  className="subtle-button compare-button"
                  type="button"
                  onClick={() => runModes(architectures)}
                  disabled={running}
                >
                  对照三种架构
                </button>
                {running ? (
                  <button
                    className="subtle-button"
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                  >
                    停止
                  </button>
                ) : null}
                <button
                  className="subtle-button"
                  type="button"
                  onClick={resetTrace}
                  disabled={!hasRuns}
                >
                  清空结果
                </button>
              </div>
              {inputError ? (
                <p className="input-error" role="alert">
                  {inputError}
                </p>
              ) : null}
              <div className="tools-heading">
                <div>
                  <h2>可用工具</h2>
                  <p>展开可修改工具和返回结果</p>
                </div>
                <button
                  className="subtle-button"
                  type="button"
                  onClick={() => {
                    setTools((current) => [
                      ...current,
                      {
                        id: crypto.randomUUID(),
                        name: `tool_${current.length + 1}`,
                        description: "说明何时使用这个工具",
                        resultText: "{}",
                      },
                    ]);
                    setExample("custom");
                    setRuns(emptyRuns());
                  }}
                  disabled={running || tools.length >= 8}
                >
                  + 添加
                </button>
              </div>
              <div className="tool-list">
                {tools.map((tool, index) => (
                  <details className="tool-editor" key={tool.id}>
                    <summary>
                      <strong>{tool.name || `工具 ${index + 1}`}</strong>
                    </summary>
                    <div className="tool-editor-heading">
                      <span>名称、说明和模拟结果</span>
                      <button
                        type="button"
                        onClick={() => {
                          setTools((current) => current.filter((item) => item.id !== tool.id));
                          setExample("custom");
                          setRuns(emptyRuns());
                        }}
                        disabled={running || tools.length === 1}
                        aria-label={`移除工具 ${tool.name || index + 1}`}
                      >
                        移除
                      </button>
                    </div>
                    <label className="field">
                      <span>名称</span>
                      <input
                        value={tool.name}
                        onChange={(event) => updateTool(tool.id, "name", event.target.value)}
                        disabled={running}
                        spellCheck={false}
                      />
                    </label>
                    <label className="field">
                      <span>说明</span>
                      <input
                        value={tool.description}
                        onChange={(event) => updateTool(tool.id, "description", event.target.value)}
                        disabled={running}
                      />
                    </label>
                    <label className="field">
                      <span>模拟返回 JSON</span>
                      <textarea
                        className="tool-result-input"
                        value={tool.resultText}
                        onChange={(event) => updateTool(tool.id, "resultText", event.target.value)}
                        disabled={running}
                        rows={2}
                        spellCheck={false}
                      />
                    </label>
                  </details>
                ))}
              </div>
            </div>
          </aside>

          <section className="trace">
            <ArchitectureDiagram
              architecture={architecture}
              name={architectureNames[architecture]}
            />
            {hasRuns ? (
              <div className="comparison">
                <div className="comparison-heading">
                  <h2>架构对照</h2>
                  <p>相同任务和工具，点选卡片查看各自的 trace。</p>
                </div>
                <div className="comparison-grid">
                  {architectures.map((mode) => {
                    const record = runs[mode];
                    const order = record ? calledTools(record.events) : [];
                    return (
                      <button
                        type="button"
                        key={mode}
                        className={`comparison-card${architecture === mode ? " selected" : ""}`}
                        onClick={() => setArchitecture(mode)}
                        disabled={!record}
                        aria-pressed={architecture === mode}
                      >
                        <span className="comparison-card-top">
                          <strong>{architectureNames[mode]}</strong>
                          <small>
                            {record?.status === "running"
                              ? "运行中"
                              : record?.status === "complete"
                                ? "完成"
                                : record?.status === "error"
                                  ? "出错"
                                  : record?.status === "stopped"
                                    ? "已停止"
                                    : "未运行"}
                          </small>
                        </span>
                        <span className="comparison-metrics">
                          模型 {record ? modelCalls(record.events) : "—"} 次 · 工具{" "}
                          {record ? order.length : "—"} 次 ·{" "}
                          {formatDuration(record?.durationMs ?? null)}
                        </span>
                        <span className="comparison-order">
                          工具顺序：{record ? (order.length ? order.join(" → ") : "未调用") : "—"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="trace-heading">
              <div className="section-title">
                <h2>{architectureNames[architecture]} · 运行过程</h2>
              </div>
              <div className="trace-stats">
                <span>{modelCount} 次模型请求</span>
                <span>{toolCount} 次工具调用</span>
              </div>
            </div>
            {!events.length ? (
              <div className="empty-state">
                <div className="empty-icon">{selectedRun?.status === "running" ? "···" : "{}"}</div>
                <strong>
                  {selectedRun?.status === "running"
                    ? "正在等待模型响应"
                    : hasRuns
                      ? "这个架构尚未运行"
                      : "等待运行"}
                </strong>
                <p>运行后查看每一步的输入、决定和结果。</p>
              </div>
            ) : (
              <div className="event-list" aria-live="polite">
                {events.map((event, index) => {
                  if (event.type === "plan")
                    return (
                      <article
                        className="plan-event"
                        key={index}
                        id={`trace-${architecture}-${index}`}
                        tabIndex={-1}
                      >
                        <div className="event-heading">
                          <span className="plan-chip">计划</span>
                          <h3>{event.source === "fixed" ? "按规则确定顺序" : "模型制定步骤"}</h3>
                        </div>
                        <div className="step-summary">
                          <div>
                            <span className="step-label">执行顺序</span>
                            <strong>
                              {event.status && event.status >= 400
                                ? `生成失败（${event.status}）`
                                : event.steps.length
                                  ? event.steps.map((step) => step.name).join(" → ")
                                  : "无需工具"}
                            </strong>
                          </div>
                        </div>
                        <TraceFields
                          events={events}
                          index={index}
                          links={traceLinks}
                          onInspect={inspectField}
                        />
                        <RawDetails>
                          {event.source === "model" ? (
                            <div className="io-grid">
                              <JsonPanel title="发给模型 · 完整请求" value={event.request} />
                              <JsonPanel title="模型返回 · 完整响应" value={event.response} />
                            </div>
                          ) : (
                            <JsonPanel title="执行器生成的步骤" value={event.steps} />
                          )}
                        </RawDetails>
                      </article>
                    );
                  if (event.type === "model") {
                    const { query, previousTools, availableTools, calledTools } =
                      modelSummary(event);
                    return (
                      <article
                        className="model-event"
                        key={index}
                        id={`trace-${architecture}-${index}`}
                        tabIndex={-1}
                      >
                        <div className="event-heading">
                          <span className="round-chip">
                            {event.purpose === "summary" ? "总结" : `第 ${event.round} 轮`}
                          </span>
                          <h3>{event.purpose === "summary" ? "模型总结" : "问模型"}</h3>
                          <small>HTTP {event.status}</small>
                        </div>
                        <div className="step-summary">
                          <div>
                            <span className="step-label">传入</span>
                            <span>
                              {previousTools.length
                                ? `原问题 + ${previousTools.join("、")} 的结果`
                                : typeof query === "string"
                                  ? query
                                  : "用户问题"}
                            </span>
                          </div>
                          {event.purpose !== "summary" ? (
                            <div>
                              <span className="step-label">可选工具</span>
                              <span>
                                {availableTools.length ? availableTools.join("、") : "无"}
                              </span>
                            </div>
                          ) : null}
                          <div className="decision-row">
                            <span className="step-label">
                              {event.purpose === "summary" ? "输出" : "模型决定"}
                            </span>
                            <strong>
                              {event.status !== 200
                                ? `请求失败（${event.status}）`
                                : event.purpose === "summary"
                                  ? "生成最终回答"
                                  : calledTools.length
                                    ? `调用 ${calledTools.join("、")}`
                                    : "给出最终回答"}
                            </strong>
                          </div>
                        </div>
                        {calledTools.length > 1 ? (
                          <p className="batch-call-note">
                            本轮返回 {calledTools.length} 个调用，不符合当前每轮一个工具的规则。
                          </p>
                        ) : null}
                        <TraceFields
                          events={events}
                          index={index}
                          links={traceLinks}
                          onInspect={inspectField}
                        />
                        <RawDetails>
                          <div className="io-grid">
                            <JsonPanel title="发给模型 · 完整请求" value={event.request} />
                            <JsonPanel title="模型返回 · 完整响应" value={event.response} />
                          </div>
                        </RawDetails>
                      </article>
                    );
                  }
                  if (event.type === "tool")
                    return (
                      <article
                        className="tool-event"
                        key={index}
                        id={`trace-${architecture}-${index}`}
                        tabIndex={-1}
                      >
                        <div className="event-heading">
                          <span className="tool-chip">工具</span>
                          <h3>{event.name}</h3>
                        </div>
                        <TraceFields
                          events={events}
                          index={index}
                          links={traceLinks}
                          onInspect={inspectField}
                        />
                        <RawDetails>
                          <div className="tool-grid">
                            <JsonPanel title="工具收到的参数" value={event.arguments} />
                            <JsonPanel title="完整 Observation" value={event.observation} />
                            <JsonPanel title="写入上下文的消息" value={event.appended_message} />
                          </div>
                        </RawDetails>
                      </article>
                    );
                  if (event.type === "final")
                    return (
                      <article
                        className="final-event"
                        key={index}
                        id={`trace-${architecture}-${index}`}
                        tabIndex={-1}
                      >
                        <span>结束 · {event.reason}</span>
                        <h3>最终回答</h3>
                        <p>{event.answer || "模型未返回文字回答"}</p>
                      </article>
                    );
                  return (
                    <p className="stream-error" role="alert" key={index}>
                      {event.message}
                    </p>
                  );
                })}
                {selectedRun?.status === "running" ? (
                  <p className="running-state">正在等待下一步…</p>
                ) : null}
              </div>
            )}
          </section>
        </div>
      </div>
      <TraceInspector
        selection={inspection?.selection ?? null}
        events={inspectionEvents}
        links={inspectionLinks}
        onClose={() => setInspection(null)}
        onLocate={locateTrace}
      />
    </main>
  );
}
