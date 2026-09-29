import { useId } from "react";

type Architecture = "react" | "fixed" | "plan";
type Tone = "neutral" | "model" | "tool" | "answer" | "plan";

const descriptions: Record<Architecture, string> = {
  react:
    "用户问题交给模型决策。每轮最多调用一个尚未使用的工具，把结果写入上下文，再回到模型决策；没有工具调用时，输出最终回答。每个工具最多调用一次。",
  fixed:
    "按用户问题中出现的工具名筛选工具；未提到工具名时使用全部工具。执行器按工具配置顺序执行，再由模型汇总结果并回答。",
  plan: "模型根据用户问题先生成工具和参数清单，执行器按计划执行，再交给模型总结并回答。执行过程中不重新规划。",
};

const captions: Record<Architecture, string> = {
  react: "每轮一个工具，观察后再决定；每个工具最多调用一次。",
  fixed: "规则选工具、定顺序，模型只负责最后总结。",
  plan: "模型先定计划；执行过程中不重新规划。",
};

function Node({
  x,
  y,
  width = 152,
  height = 58,
  title,
  detail,
  tone = "neutral",
}: {
  x: number;
  y: number;
  width?: number;
  height?: number;
  title: string;
  detail: string;
  tone?: Tone;
}) {
  return (
    <g className={`flow-node flow-node-${tone}`} transform={`translate(${x} ${y})`}>
      <rect width={width} height={height} rx="10" />
      <text className="flow-node-title" x={width / 2} y={height / 2 - 5}>
        {title}
      </text>
      <text className="flow-node-detail" x={width / 2} y={height / 2 + 14}>
        {detail}
      </text>
    </g>
  );
}

function Edge({
  d,
  marker,
  tone = "neutral",
}: {
  d: string;
  marker: string;
  tone?: "neutral" | "loop" | "exit";
}) {
  return (
    <path className={`flow-edge flow-edge-${tone}`} d={d} markerEnd={`url(#${marker}-${tone})`} />
  );
}

function Decision({ x, y }: { x: number; y: number }) {
  return (
    <g className="flow-decision" transform={`translate(${x} ${y})`}>
      <path d="M 0 -32 L 65 0 L 0 32 L -65 0 Z" />
      <text x="0" y="4">
        调用工具？
      </text>
    </g>
  );
}

function ReactFlow({ marker, compact }: { marker: string; compact: boolean }) {
  if (compact)
    return (
      <>
        <Edge d="M 154 58 V 88" marker={marker} />
        <Edge d="M 154 142 V 163" marker={marker} />
        <Edge d="M 154 227 V 258" marker={marker} tone="loop" />
        <Edge d="M 154 310 V 344" marker={marker} tone="loop" />
        <Edge
          d="M 69 370 H 36 Q 26 370 26 360 V 125 Q 26 115 36 115 H 69"
          marker={marker}
          tone="loop"
        />
        <Edge
          d="M 219 195 H 270 Q 280 195 280 205 V 450 Q 280 460 270 460 H 239"
          marker={marker}
          tone="exit"
        />
        <text className="flow-label flow-label-loop" x="171" y="247">
          是
        </text>
        <text className="flow-label flow-label-exit" x="250" y="184">
          否
        </text>
        <text className="flow-label flow-label-loop" transform="translate(17 258) rotate(-90)">
          带结果再问模型
        </text>
        <Node x={69} y={10} width={170} height={48} title="用户问题" detail="query" />
        <Node
          x={69}
          y={88}
          width={170}
          height={54}
          title="模型决策"
          detail="上下文 + 可用工具"
          tone="model"
        />
        <Decision x={154} y={195} />
        <Node
          x={69}
          y={258}
          width={170}
          height={52}
          title="执行工具"
          detail="工具名 + 参数"
          tone="tool"
        />
        <Node
          x={69}
          y={344}
          width={170}
          height={52}
          title="观察结果"
          detail="写入 messages"
          tone="tool"
        />
        <Node x={69} y={434} width={170} height={52} title="最终回答" detail="结束" tone="answer" />
      </>
    );
  return (
    <>
      <Edge d="M 164 69 H 240" marker={marker} />
      <Edge d="M 400 69 H 447" marker={marker} />
      <Edge d="M 577 69 H 658" marker={marker} tone="exit" />
      <Edge d="M 512 101 V 209" marker={marker} tone="loop" />
      <Edge d="M 448 238 H 400" marker={marker} tone="loop" />
      <Edge d="M 320 209 V 98" marker={marker} tone="loop" />
      <text className="flow-label flow-label-exit" x="617" y="56">
        否，直接回答
      </text>
      <text className="flow-label flow-label-loop" x="532" y="158">
        是
      </text>
      <text className="flow-label flow-label-loop" x="416" y="156">
        读取结果
      </text>
      <text className="flow-label flow-label-loop" x="416" y="174">
        再做决定
      </text>
      <Node x={24} y={40} width={140} title="用户问题" detail="query" />
      <Node x={240} y={40} width={160} title="模型决策" detail="上下文 + 可用工具" tone="model" />
      <Decision x={512} y={69} />
      <Node x={658} y={40} width={154} title="最终回答" detail="结束" tone="answer" />
      <Node x={448} y={209} width={128} title="执行工具" detail="工具名 + 参数" tone="tool" />
      <Node x={240} y={209} width={160} title="观察结果" detail="写入 messages" tone="tool" />
    </>
  );
}

function FixedFlow({ marker, compact }: { marker: string; compact: boolean }) {
  const steps = [
    { title: "用户问题", detail: "query", tone: "neutral" },
    { title: "规则筛选", detail: "按工具配置顺序", tone: "plan" },
    { title: "依次执行", detail: "选中的工具", tone: "tool" },
    { title: "模型总结", detail: "问题 + 执行结果", tone: "model" },
    { title: "最终回答", detail: "结束", tone: "answer" },
  ] as const;
  return (
    <>
      {!compact && (
        <rect className="flow-executor-lane" x="176" y="21" width="312" height="113" rx="14" />
      )}
      {!compact && (
        <text className="flow-label" x="332" y="44">
          执行器 · 按规则运行
        </text>
      )}
      {steps.map((step, index) => (
        <g key={step.title}>
          {index < steps.length - 1 && (
            <Edge
              d={
                compact
                  ? `M 150 ${72 + index * 86} V ${100 + index * 86}`
                  : `M ${148 + index * 167} 90 H ${187 + index * 167}`
              }
              marker={marker}
            />
          )}
          <Node
            {...step}
            x={compact ? 55 : 20 + index * 167}
            y={compact ? 14 + index * 86 : 61}
            width={compact ? 190 : 128}
          />
        </g>
      ))}
    </>
  );
}

function PlanFlow({ marker, compact }: { marker: string; compact: boolean }) {
  if (compact)
    return (
      <>
        <rect className="flow-executor-lane" x="39" y="148" width="222" height="173" rx="14" />
        <text className="flow-label" x="220" y="167">
          执行器
        </text>
        <Edge d="M 150 58 V 88" marker={marker} />
        <Edge d="M 150 138 V 180" marker={marker} />
        <Edge d="M 150 230 V 258" marker={marker} />
        <Edge d="M 150 308 V 348" marker={marker} />
        <Edge d="M 150 398 V 428" marker={marker} />
        <Node x={55} y={10} width={190} height={48} title="用户问题" detail="query" />
        <Node
          x={55}
          y={88}
          width={190}
          height={50}
          title="模型规划"
          detail="一次决定全部步骤"
          tone="model"
        />
        <Node
          x={55}
          y={180}
          width={190}
          height={50}
          title="计划清单"
          detail="工具顺序 + 各步参数"
          tone="plan"
        />
        <Node
          x={55}
          y={258}
          width={190}
          height={50}
          title="按计划执行"
          detail="0～N 步，不重新规划"
          tone="tool"
        />
        <Node
          x={55}
          y={348}
          width={190}
          height={50}
          title="模型总结"
          detail="问题 + 执行结果"
          tone="model"
        />
        <Node x={55} y={428} width={190} height={50} title="最终回答" detail="结束" tone="answer" />
      </>
    );
  return (
    <>
      <rect className="flow-executor-lane" x="620" y="14" width="208" height="271" rx="14" />
      <text className="flow-label" x="724" y="38">
        执行器
      </text>
      <Edge d="M 170 87 H 318" marker={marker} />
      <Edge d="M 478 87 H 640" marker={marker} />
      <Edge d="M 724 116 V 206" marker={marker} />
      <Edge d="M 640 235 H 478" marker={marker} />
      <Edge d="M 318 235 H 170" marker={marker} />
      <text className="flow-label" x="559" y="74">
        生成计划
      </text>
      <text className="flow-label" x="772" y="165">
        依次调用
      </text>
      <text className="flow-label" x="559" y="222">
        汇总结果
      </text>
      <Node x={24} y={58} width={146} title="用户问题" detail="query" />
      <Node x={318} y={58} width={160} title="模型规划" detail="一次决定全部步骤" tone="model" />
      <Node x={640} y={58} width={168} title="计划清单" detail="工具顺序 + 各步参数" tone="plan" />
      <Node
        x={640}
        y={206}
        width={168}
        title="按计划执行"
        detail="0～N 步，不重新规划"
        tone="tool"
      />
      <Node x={318} y={206} width={160} title="模型总结" detail="问题 + 执行结果" tone="model" />
      <Node x={24} y={206} width={146} title="最终回答" detail="结束" tone="answer" />
    </>
  );
}

export function ArchitectureDiagram({
  architecture,
  name,
}: {
  architecture: Architecture;
  name: string;
}) {
  const id = useId().replace(/:/g, "");
  return (
    <section className="architecture-diagram" aria-labelledby={`${id}-heading`}>
      <div className="architecture-diagram-heading">
        <h2 id={`${id}-heading`}>架构图</h2>
        <span>{name}</span>
      </div>
      <div className="flow-stage">
        {[false, true].map((compact) => {
          const marker = `${id}-${compact ? "compact" : "wide"}`;
          const height = compact
            ? architecture === "fixed"
              ? 430
              : 500
            : architecture === "fixed"
              ? 156
              : 300;
          return (
            <svg
              key={marker}
              className={`architecture-flow ${compact ? "flow-compact" : "flow-wide"}`}
              viewBox={`0 0 ${compact ? 300 : 840} ${height}`}
              role="img"
              aria-labelledby={`${marker}-title ${marker}-description`}
            >
              <title id={`${marker}-title`}>{`${name}架构图`}</title>
              <desc id={`${marker}-description`}>{descriptions[architecture]}</desc>
              <defs>
                {(["neutral", "loop", "exit"] as const).map((tone) => (
                  <marker
                    key={tone}
                    id={`${marker}-${tone}`}
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="4"
                    orient="auto"
                    markerUnits="userSpaceOnUse"
                  >
                    <path
                      className={`flow-arrowhead flow-arrowhead-${tone}`}
                      d="M 1 1 L 7 4 L 1 7 Z"
                    />
                  </marker>
                ))}
              </defs>
              {architecture === "react" ? (
                <ReactFlow marker={marker} compact={compact} />
              ) : architecture === "fixed" ? (
                <FixedFlow marker={marker} compact={compact} />
              ) : (
                <PlanFlow marker={marker} compact={compact} />
              )}
            </svg>
          );
        })}
      </div>
      <p className="diagram-caption">{captions[architecture]}</p>
    </section>
  );
}
