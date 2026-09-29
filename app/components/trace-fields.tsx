"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Copy, Link2, X } from "lucide-react";
import type { ToolTraceLink, TraceEvent } from "@/lib/trace-links";

export type TraceSelection = {
  eventIndex: number;
  path: string;
  label: string;
  value: unknown;
  toolIndex?: number;
  callId?: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, pretty = false): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, pretty ? 2 : undefined) ?? "未提供";
}

function appendPath(path: string, key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

const fieldNames: Record<string, string> = {
  input: "输入内容",
  value: "结果值",
  need_b: "需要调用 b",
  content: "消息内容",
  result: "返回结果",
  arguments: "工具参数",
};

function leaves(
  value: unknown,
  path: string,
  depth = 0,
): Array<{ path: string; label: string; value: unknown }> {
  const object = record(value);
  const entries = object ? Object.entries(object) : [];
  if (!entries.length || depth >= 2 || entries.length > 4) {
    const key = path.split(".").at(-1) ?? path;
    return [{ path, label: fieldNames[key] ?? key, value }];
  }
  return entries.flatMap(([key, child]) => leaves(child, appendPath(path, key), depth + 1));
}

function Field({
  selection,
  display,
  onInspect,
}: {
  selection: TraceSelection;
  display?: string;
  onInspect: (selection: TraceSelection) => void;
}) {
  const value = display ?? text(selection.value);
  const shortPath = selection.path
    .replace(/^response\.choices\[0\]\.message\./, "")
    .replace(/^response\.choices\[0\]\./, "")
    .replace(/^request\./, "")
    .replace(/^observation\./, "")
    .replace(/^appended_message\./, "");
  return (
    <button
      type="button"
      className="trace-field"
      onClick={() => onInspect(selection)}
      aria-label={`追踪 ${selection.label} · ${shortPath}`}
    >
      <span className="trace-field-key">
        <span>{selection.label}</span>
        <code>{shortPath}</code>
      </span>
      <code className="trace-field-value">
        {value.length > 180 ? `${value.slice(0, 180)}…` : value}
      </code>
      <Link2 size={13} aria-hidden="true" />
    </button>
  );
}

export function TraceFields({
  events,
  index,
  links,
  onInspect,
}: {
  events: TraceEvent[];
  index: number;
  links: ToolTraceLink[];
  onInspect: (selection: TraceSelection) => void;
}) {
  const event = events[index];
  if (!event) return null;
  const fields: Array<{ selection: TraceSelection; display?: string }> = [];
  let linked: ToolTraceLink | undefined;
  const add = (
    path: string,
    label: string,
    value: unknown,
    extra: Partial<TraceSelection> = {},
    display?: string,
  ) => {
    fields.push({ selection: { eventIndex: index, path, label, value, ...extra }, display });
  };

  if (event.type === "tool") {
    linked = links.find((link) => link.toolIndex === index);
    if (linked?.callId)
      add("appended_message.tool_call_id", "调用 ID", linked.callId, { toolIndex: index });
    for (const field of leaves(event.arguments, "arguments"))
      add(field.path, field.label, field.value, { toolIndex: index });
    const observation = record(event.observation);
    const hasResult = observation && Object.hasOwn(observation, "result");
    for (const field of leaves(
      hasResult ? observation.result : event.observation,
      hasResult ? "observation.result" : "observation",
    )) {
      add(field.path, field.label, field.value, { toolIndex: index });
    }
  } else if (event.type === "model" || (event.type === "plan" && event.source === "model")) {
    const request = record(event.request);
    const response = record(event.response);
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    if (request?.messages !== undefined)
      add(
        "request.messages",
        "传入上下文",
        request.messages,
        {},
        `${messages.length} 条消息 · ${messages.map((message) => record(message)?.role ?? "?").join(" → ")}`,
      );
    for (const link of links.filter((item) => item.context?.eventIndex === index)) {
      const tool = events[link.toolIndex];
      if (tool?.type !== "tool" || !link.context) continue;
      let contextValue = record(link.context.value)?.content;
      if (typeof contextValue === "string") {
        try {
          contextValue = JSON.parse(contextValue);
          const contextRecord = record(contextValue);
          if (contextRecord && Object.hasOwn(contextRecord, "result"))
            contextValue = contextRecord.result;
        } catch {
          // Executor messages may be plain text; show what was actually sent.
        }
      }
      add(
        link.context.path,
        `带入 ${tool.name} 的结果`,
        link.context.value,
        { toolIndex: link.toolIndex },
        text(contextValue),
      );
    }
    const choice = record(Array.isArray(response?.choices) ? response.choices[0] : undefined);
    const message = record(choice?.message);
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    calls.forEach((call, callIndex) => {
      const item = record(call);
      const fn = record(item?.function);
      const callId = typeof item?.id === "string" ? item.id : undefined;
      add(
        `response.choices[0].message.tool_calls[${callIndex}]`,
        `调用 ${typeof fn?.name === "string" ? fn.name : "未知工具"}`,
        call,
        { callId },
        `${text(fn?.name)} · arguments: ${text(fn?.arguments)}`,
      );
    });
    if (
      message &&
      Object.hasOwn(message, "content") &&
      message.content !== null &&
      message.content !== ""
    )
      add(
        "response.choices[0].message.content",
        event.type === "plan" ? "模型计划" : "模型正文",
        message.content,
      );
    if (choice?.finish_reason !== undefined)
      add("response.choices[0].finish_reason", "结束原因", choice.finish_reason);
    if (response?.error !== undefined) add("response.error", "错误详情", response.error);
    if (typeof event.response === "string") add("response", "原始响应", event.response);
    if (event.type === "plan") add("steps", "执行计划", event.steps);
  } else if (event.type === "plan") {
    add("steps", "执行计划", event.steps);
  }

  if (!fields.length) return null;
  return (
    <div className="trace-fields">
      <div className="trace-fields-heading">
        <span>关键字段</span>
        <small>点击追踪</small>
      </div>
      {fields.map(({ selection, display }) => (
        <Field key={selection.path} selection={selection} display={display} onInspect={onInspect} />
      ))}
      {linked && (
        <div className="trace-connections">
          {linked.source && (
            <button
              type="button"
              onClick={() =>
                onInspect({
                  eventIndex: index,
                  path: "arguments",
                  label: "参数来源",
                  value: event.type === "tool" ? event.arguments : undefined,
                  toolIndex: index,
                })
              }
            >
              ← 参数来源
            </button>
          )}
          <span>
            {linked.context
              ? `→ 已写入 ${linked.context.path.replace(/^request\./, "")}`
              : "尚无后续上下文记录"}
          </span>
        </div>
      )}
      {linked?.issues.length ? (
        <p className="trace-warning" role="status">
          {linked.issues.join("；")}
        </p>
      ) : null}
    </div>
  );
}

function eventLabel(event: TraceEvent | undefined, index: number) {
  if (event?.type === "model")
    return event.purpose === "summary" ? "模型总结" : `第 ${event.round} 轮模型`;
  if (event?.type === "tool") return `工具 ${event.name}`;
  if (event?.type === "plan") return event.source === "fixed" ? "规则计划" : "模型计划";
  return `步骤 ${index + 1}`;
}

export function TraceInspector({
  selection,
  events,
  links,
  onClose,
  onLocate,
}: {
  selection: TraceSelection | null;
  events: TraceEvent[];
  links: ToolTraceLink[];
  onClose: () => void;
  onLocate: (index: number) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copyStatus, setCopyStatus] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    if (selection && !dialog.current?.open) dialog.current?.showModal();
    if (!selection && dialog.current?.open) dialog.current.close();
  }, [selection]);

  const linked = selection
    ? links.find((link) =>
        selection.toolIndex !== undefined
          ? link.toolIndex === selection.toolIndex
          : Boolean(selection.callId) &&
            link.callId === selection.callId &&
            link.source?.eventIndex === selection.eventIndex,
      )
    : undefined;
  const tool = linked ? events[linked.toolIndex] : undefined;
  const hops: Array<{ eventIndex: number; path: string; value: unknown; label: string }> = [];
  if (linked?.source) hops.push({ ...linked.source, label: "参数来源" });
  if (linked && tool?.type === "tool") {
    hops.push({
      eventIndex: linked.toolIndex,
      path: "arguments",
      value: tool.arguments,
      label: "工具输入",
    });
    hops.push({
      eventIndex: linked.toolIndex,
      path: "observation",
      value: tool.observation,
      label: "工具返回",
    });
  }
  if (linked?.context) hops.push({ ...linked.context, label: "后续模型输入" });
  const selectionKey = selection ? `${selection.eventIndex}:${selection.path}` : "";
  const locate = (index: number) => {
    dialog.current?.close();
    onLocate(index);
  };

  return (
    <dialog
      ref={dialog}
      className="trace-inspector"
      onClose={onClose}
      aria-labelledby="trace-inspector-title"
    >
      {selection && (
        <>
          <header className="trace-inspector-header">
            <div>
              <h2 id="trace-inspector-title">字段追踪</h2>
              <p>
                {selection.label} · {eventLabel(events[selection.eventIndex], selection.eventIndex)}
              </p>
            </div>
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => dialog.current?.close()}
              aria-label="关闭字段追踪"
            >
              <X size={18} />
            </button>
          </header>
          <div className="trace-inspector-body">
            <section className="trace-selected-field">
              <code className="trace-path">{selection.path}</code>
              <pre>{text(selection.value, true)}</pre>
              <div className="trace-inspector-actions">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(text(selection.value, true));
                      setCopyStatus({ key: selectionKey, text: "已复制" });
                    } catch {
                      setCopyStatus({ key: selectionKey, text: "复制失败，请手动选取" });
                    }
                  }}
                >
                  <Copy size={13} />
                  {copyStatus?.key === selectionKey ? copyStatus.text : "复制值"}
                </button>
                <button type="button" onClick={() => locate(selection.eventIndex)}>
                  <ArrowUpRight size={13} />
                  定位原始 JSON
                </button>
              </div>
            </section>
            {hops.length > 0 && (
              <>
                <h3 className="trace-chain-title">字段所在调用链</h3>
                <ol className="trace-chain">
                  {hops.map((hop, index) => (
                    <li key={`${hop.eventIndex}:${hop.path}`}>
                      <div className="trace-hop-heading">
                        <span>{index + 1}</span>
                        <strong>{hop.label}</strong>
                        <button type="button" onClick={() => locate(hop.eventIndex)}>
                          {eventLabel(events[hop.eventIndex], hop.eventIndex)}{" "}
                          <ArrowUpRight size={12} />
                        </button>
                      </div>
                      <code className="trace-path">{hop.path}</code>
                      <pre>{text(hop.value, true)}</pre>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {linked && !linked.context && (
              <p className="trace-pending">尚无可关联的后续模型输入。</p>
            )}
            {selection.callId && !linked && (
              <p className="trace-pending">该调用暂无工具执行记录。</p>
            )}
            {linked?.issues.length ? (
              <div className="trace-warning" role="status">
                {linked.issues.map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
              </div>
            ) : null}
          </div>
        </>
      )}
    </dialog>
  );
}
