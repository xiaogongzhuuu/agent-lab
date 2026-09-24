"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Bot, Box, Braces, Check, ChevronDown, CircleStop, Clock3, Copy, Database, FlaskConical, Play, RotateCcw, Search, Sparkles, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";

type AgentEvent = { id: string; type: "status" | "tool_call" | "tool_result" | "final" | "error"; title: string; detail?: string; tool?: string; input?: Record<string, unknown>; output?: unknown; duration?: number };
type FinalResult = { summary: string; recommendation: string; evidence: string[]; risks: string[]; next_steps: string[] };

const sampleResult: FinalResult = {
  summary: "为 10 人产品团队筛选了一套低维护、可扩展的 AI 知识库方案。",
  recommendation: "优先采用 Notion AI + Slack 同步的轻量组合，先用 2 周验证检索命中率。",
  evidence: ["团队规模与现有工作流匹配", "综合评分 4.7/5", "月成本控制在 ¥1,200 内"],
  risks: ["历史文档需要一次性清洗", "复杂权限场景需额外验证"],
  next_steps: ["导入 50 篇高频文档", "邀请 3 名核心用户试用", "第 14 天复盘命中率"],
};

const sampleEvents: AgentEvent[] = [
  { id: "s1", type: "status", title: "理解任务并制定检索计划", detail: "将问题拆为需求、口碑、成本三个维度" },
  { id: "s2", type: "tool_call", title: "调用 search_solutions", tool: "search_solutions", input: { team_size: 10, category: "AI knowledge base" } },
  { id: "s3", type: "tool_result", title: "返回 4 个候选方案", tool: "search_solutions", output: { matches: 4, top_score: 4.8 }, duration: 184 },
  { id: "s4", type: "tool_call", title: "调用 analyze_reviews", tool: "analyze_reviews", input: { candidates: ["Notion AI", "Guru", "Slite"] } },
  { id: "s5", type: "tool_result", title: "完成 1,284 条评论分析", tool: "analyze_reviews", output: { positive: "82%", common_risk: "权限配置" }, duration: 326 },
  { id: "s6", type: "tool_call", title: "调用 compare_pricing", tool: "compare_pricing", input: { seats: 10, currency: "CNY" } },
  { id: "s7", type: "tool_result", title: "生成成本对比", tool: "compare_pricing", output: { lowest_monthly: 680, budget_fit: true }, duration: 142 },
  { id: "s8", type: "final", title: "生成结构化建议", detail: "已综合需求、口碑与价格证据" },
];

const suggestions = [
  "帮我为 10 人产品团队选择 AI 知识库方案，预算每月 1500 元",
  "为上海三天团队出行做行程方案，兼顾预算和雨天备选",
  "比较三个用户研究工具，并给出适合初创团队的建议",
];
const toolIcons: Record<string, typeof Search> = { search_solutions: Search, analyze_reviews: Database, compare_pricing: Box };

function JsonView({ value }: { value: unknown }) { return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>; }

function EventCard({ event, index, active }: { event: AgentEvent; index: number; active: boolean }) {
  const Icon = event.type === "tool_call" ? Wrench : event.type === "tool_result" ? toolIcons[event.tool ?? ""] ?? Database : event.type === "final" ? Sparkles : event.type === "error" ? CircleStop : Bot;
  return (
    <article className={`trace-card ${event.type} ${active ? "active" : ""}`}>
      <div className="trace-rail"><span className="trace-icon"><Icon /></span><span className="trace-line" /></div>
      <div className="trace-body">
        <div className="trace-heading"><div><span className="trace-kicker">{event.type === "tool_call" ? `STEP ${index + 1} · TOOL CALL` : event.type === "tool_result" ? `STEP ${index + 1} · TOOL RESULT` : event.type === "final" ? "FINAL · STRUCTURED OUTPUT" : event.type === "error" ? "ERROR" : `STEP ${index + 1} · AGENT`}</span><h3>{event.title}</h3></div>{event.duration ? <span className="duration"><Clock3 /> {event.duration}ms</span> : null}</div>
        {event.detail ? <p className="trace-detail">{event.detail}</p> : null}
        {event.input ? <div className="payload"><span>arguments</span><JsonView value={event.input} /></div> : null}
        {event.output !== undefined ? <div className="payload result"><span>result</span><JsonView value={event.output} /></div> : null}
      </div>
    </article>
  );
}

export default function Home() {
  const [question, setQuestion] = useState(suggestions[0]);
  const [events, setEvents] = useState<AgentEvent[]>(sampleEvents);
  const [result, setResult] = useState<FinalResult | null>(sampleResult);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(1.8);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const progress = useMemo(() => running ? Math.min(92, 12 + events.length * 11) : result ? 100 : 0, [running, events.length, result]);

  useEffect(() => { if (!running) return; const started = Date.now(); const timer = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 100); return () => window.clearInterval(timer); }, [running]);
  useEffect(() => { if (running) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [events, running]);

  async function runAgent() {
    if (!question.trim() || running) return;
    const controller = new AbortController(); abortRef.current = controller; setRunning(true); setEvents([]); setResult(null); setElapsed(0);
    try {
      const response = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }), signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("Agent 服务暂时不可用");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) { if (!line.trim()) continue; const event = JSON.parse(line) as AgentEvent; setEvents((current) => [...current, event]); if (event.type === "final" && event.output) setResult(event.output as FinalResult); }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") setEvents((current) => [...current, { id: crypto.randomUUID(), type: "error", title: "运行中断", detail: (error as Error).message }]);
    } finally { setRunning(false); abortRef.current = null; }
  }

  function resetDemo() { abortRef.current?.abort(); setRunning(false); setEvents(sampleEvents); setResult(sampleResult); setElapsed(1.8); }
  async function copyResult() { if (!result) return; await navigator.clipboard.writeText(JSON.stringify(result, null, 2)); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }

  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool?: (tool: unknown, options?: { signal?: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({ name: "prepare_agent_demo", title: "准备 Agent 演示", description: "在页面中填写问题，准备可视化 Agent 工具调用循环。", inputSchema: { type: "object", properties: { question: { type: "string", minLength: 3 } }, required: ["question"], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: async (input: unknown) => { const value = input as { question?: string }; if (!value.question?.trim()) throw new Error("question is required"); setQuestion(value.question.trim()); return { status: "ready", question: value.question.trim() }; } }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar"><div className="brand"><span className="brand-mark"><Braces /></span><div><strong>Agent Trace</strong><span>Studio</span></div></div><div className="model-pill"><span className="live-dot" /> deepseek-chat <ChevronDown /></div><div className="top-actions"><Badge variant="outline" className="env-badge">LIVE API</Badge><button className="icon-button" onClick={resetDemo} aria-label="重置演示"><RotateCcw /></button></div></header>
      <section className="workspace">
        <aside className="prompt-panel">
          <div className="panel-title"><span>01</span><div><h2>任务输入</h2><p>定义 Agent 要解决的问题</p></div></div>
          <div className="prompt-card"><label htmlFor="question">用户问题</label><Textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)} disabled={running} className="prompt-input" rows={7} /><div className="prompt-meta"><span>{question.length} 字符</span><span>⌘ ↵ 运行</span></div></div>
          <div className="suggestions"><span className="section-label">示例问题</span>{suggestions.map((suggestion, index) => <button key={suggestion} onClick={() => setQuestion(suggestion)} disabled={running}><span>0{index + 1}</span>{suggestion}<ArrowUp /></button>)}</div>
          <div className="run-area"><Button onClick={running ? () => abortRef.current?.abort() : runAgent} className={`run-button ${running ? "stop" : ""}`}>{running ? <><CircleStop /> 停止运行</> : <><Play fill="currentColor" /> 运行 Agent</>}</Button><p><FlaskConical /> 工具数据为预设结果，模型负责规划与汇总</p></div>
        </aside>
        <section className="trace-panel">
          <div className="trace-header"><div className="panel-title"><span>02</span><div><h2>执行轨迹</h2><p>React loop · 实时事件流</p></div></div><div className="run-stats"><span>{events.filter((event) => event.type === "tool_call").length} tools</span><span>{elapsed.toFixed(1)}s</span></div></div>
          <Progress value={progress} className="trace-progress" />
          <div className="trace-scroll" ref={scrollRef}>{events.length ? events.map((event, index) => <EventCard key={event.id} event={event} index={index} active={running && index === events.length - 1} />) : <div className="empty-trace"><Bot /><h3>Agent 正在启动</h3><p>第一条推理事件即将出现…</p></div>}{running ? <div className="thinking-row"><span /><span /><span /><em>DeepSeek 正在决定下一步</em></div> : null}</div>
        </section>
        <aside className="output-panel">
          <div className="output-header"><div className="panel-title"><span>03</span><div><h2>最终结果</h2><p>可直接消费的 JSON 结构</p></div></div><button className="icon-button" onClick={copyResult} disabled={!result} aria-label="复制 JSON">{copied ? <Check /> : <Copy />}</button></div>
          {result ? <div className="result-stack"><div className="result-block primary-result"><span>RECOMMENDATION</span><h3>{result.recommendation}</h3></div><div className="result-block"><span>SUMMARY</span><p>{result.summary}</p></div><div className="result-block"><span>EVIDENCE</span><ul>{result.evidence.map((item) => <li key={item}><Check />{item}</li>)}</ul></div><div className="result-grid"><div className="result-block compact"><span>RISKS</span><strong>{result.risks.length}</strong><small>项待验证</small></div><div className="result-block compact"><span>NEXT STEPS</span><strong>{result.next_steps.length}</strong><small>个后续动作</small></div></div><details className="raw-json"><summary><Braces /> 查看原始 JSON <ChevronDown /></summary><JsonView value={result} /></details></div> : <div className="empty-output"><Sparkles /><h3>{running ? "正在汇总证据" : "等待运行结果"}</h3><p>工具循环结束后，结构化结果会在这里生成。</p></div>}
          <footer className="output-footer"><span className={result ? "ready-dot" : ""} /> Schema validated <code>v1.0</code></footer>
        </aside>
      </section>
    </main>
  );
}
