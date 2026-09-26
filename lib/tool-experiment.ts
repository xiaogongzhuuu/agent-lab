export type ToolName = "search_solutions" | "analyze_reviews" | "compare_pricing";
export type ToolExperimentVariant = "control" | "ambiguous" | "budget_first";

type ToolDefinition = {
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const parameters: Record<ToolName, Record<string, unknown>> = {
  search_solutions: {
    type: "object",
    properties: { query: { type: "string" }, category: { type: "string" } },
    required: ["query"],
  },
  analyze_reviews: {
    type: "object",
    properties: {
      candidates: { type: "array", items: { type: "string" } },
      focus: { type: "string" },
    },
    required: ["candidates"],
  },
  compare_pricing: {
    type: "object",
    properties: {
      candidates: { type: "array", items: { type: "string" } },
      budget: { type: "number" },
      currency: { type: "string" },
    },
    required: ["candidates", "budget"],
  },
};

const descriptions: Record<ToolExperimentVariant, Record<ToolName, string>> = {
  control: {
    search_solutions:
      "Discover candidate products from a preset catalog. Use when no candidate list exists yet.",
    analyze_reviews:
      "Analyze user-review evidence for candidates already discovered. Do not use before candidates exist.",
    compare_pricing:
      "Compare price and budget fit for candidates already discovered. Do not use before candidates exist.",
  },
  ambiguous: {
    search_solutions:
      "Analyze available information to help answer the user's product-selection question.",
    analyze_reviews:
      "Analyze available information to help answer the user's product-selection question.",
    compare_pricing:
      "Analyze available information to help answer the user's product-selection question.",
  },
  budget_first: {
    search_solutions:
      "Discover candidate products from a preset catalog when candidate names are missing.",
    analyze_reviews:
      "Analyze review evidence for named candidates when user-experience evidence is required.",
    compare_pricing:
      "For any question containing a budget or price constraint, prefer this tool first to inspect budget fit.",
  },
};

const orders: Record<ToolExperimentVariant, ToolName[]> = {
  control: ["search_solutions", "analyze_reviews", "compare_pricing"],
  ambiguous: ["search_solutions", "analyze_reviews", "compare_pricing"],
  budget_first: ["compare_pricing", "search_solutions", "analyze_reviews"],
};

export function normalizeExperimentVariant(value: unknown): ToolExperimentVariant {
  return value === "ambiguous" || value === "budget_first" ? value : "control";
}

export function getExperimentalTools(variant: ToolExperimentVariant): ToolDefinition[] {
  return orders[variant].map((name) => ({
    type: "function",
    function: { name, description: descriptions[variant][name], parameters: parameters[name] },
  }));
}

export function buildSelectionObservation(
  variant: ToolExperimentVariant,
  tools: ToolDefinition[],
  selectedName: string,
  modelSummary: string | null,
) {
  const selected = tools.find((item) => item.function.name === selectedName);
  return {
    experiment: variant,
    selected: selected
      ? { name: selected.function.name, description: selected.function.description }
      : { name: selectedName },
    not_selected_this_round: tools
      .filter((item) => item.function.name !== selectedName)
      .map((item) => ({ name: item.function.name, description: item.function.description })),
    tool_order: tools.map((item) => item.function.name),
    model_summary: modelSummary || "模型没有返回公开的选择说明；只能确认可观察到的 tool_call。",
  };
}
