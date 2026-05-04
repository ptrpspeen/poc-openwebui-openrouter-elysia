import { runtimeConfig, writeSystemLog } from "./config";
import { getUserGroups, getUsageSnapshotAll, parseNumber } from "./quota";

export type VirtualModelStrategy = "cheap_first" | "balanced" | "premium" | "code" | "long_context";

export type VirtualModelDefinition = {
  id: string;
  name: string;
  description: string;
  strategy: VirtualModelStrategy;
  candidates: string[];
};

type TaskSignals = {
  promptTokens: number;
  keywordScore: number;
  isCodingTask: boolean;
  needsLongContext: boolean;
  needsPremiumReasoning: boolean;
};

type RouterPolicyConfig = {
  premium_model_ids: string[];
  premium_allowed_groups: string[];
  premium_daily_cost_limit: number;
  premium_monthly_cost_limit: number;
};

type PremiumAccessDecision = {
  allowed: boolean;
  reason?: string;
  groups?: string[];
  premiumConfig?: RouterPolicyConfig;
  usage?: { daily: { cost: number }; monthly: { cost: number } };
};

const VIRTUAL_MODEL_OWNER = "ai-control-plane";
const VIRTUAL_MODEL_CREATED = 1735689600;

export const DEFAULT_VIRTUAL_MODELS: VirtualModelDefinition[] = [
  {
    id: "virtual/auto-fast",
    name: "Auto Fast",
    description: "Lowest-cost routing for lightweight chat, rewrite, and summary tasks.",
    strategy: "cheap_first",
    candidates: ["google/gemini-2.5-flash", "openai/gpt-4o-mini", "anthropic/claude-3.5-haiku"],
  },
  {
    id: "virtual/auto-balanced",
    name: "Auto Balanced",
    description: "Balanced routing for most everyday coding and analysis tasks.",
    strategy: "balanced",
    candidates: ["openai/gpt-4.1-mini", "google/gemini-2.5-flash", "anthropic/claude-3.7-sonnet"],
  },
  {
    id: "virtual/auto-best",
    name: "Auto Best",
    description: "Premium routing for hard reasoning, architecture, and security-sensitive tasks.",
    strategy: "premium",
    candidates: ["anthropic/claude-opus-4", "openai/gpt-5", "google/gemini-2.5-pro"],
  },
  {
    id: "virtual/auto-code",
    name: "Auto Code",
    description: "Routing tuned for code generation, debugging, and technical analysis.",
    strategy: "code",
    candidates: ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1", "google/gemini-2.5-pro"],
  },
  {
    id: "virtual/auto-long",
    name: "Auto Long Context",
    description: "Routing for long-context requests and document-heavy prompts.",
    strategy: "long_context",
    candidates: ["google/gemini-2.5-pro", "openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
  },
];

export const DEFAULT_ROUTER_POLICY: RouterPolicyConfig = {
  premium_model_ids: ["virtual/auto-best"],
  premium_allowed_groups: ["admin", "research"],
  premium_daily_cost_limit: 0,
  premium_monthly_cost_limit: 0,
};

function parseJsonConfig<T>(raw: string, fallback: T, label: string): T {
  if (!raw || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (error: any) {
    writeSystemLog("warn", `Invalid ${label} JSON config; using defaults`, { error: error?.message || String(error) });
    return fallback;
  }
}

function normalizeVirtualModel(input: any): VirtualModelDefinition | null {
  const strategy = String(input?.strategy || "").trim() as VirtualModelStrategy;
  const candidates = Array.isArray(input?.candidates)
    ? input.candidates.map((candidate: any) => String(candidate || "").trim()).filter(Boolean)
    : [];
  if (!input?.id || !input?.name || !input?.description || !candidates.length) return null;
  if (!["cheap_first", "balanced", "premium", "code", "long_context"].includes(strategy)) return null;
  return {
    id: String(input.id).trim(),
    name: String(input.name).trim(),
    description: String(input.description).trim(),
    strategy,
    candidates,
  };
}

export function parseVirtualModelsConfig(raw: string, fallback = DEFAULT_VIRTUAL_MODELS): VirtualModelDefinition[] {
  const parsed = parseJsonConfig<any[]>(raw, fallback, "VIRTUAL_MODELS_JSON");
  if (!Array.isArray(parsed)) return DEFAULT_VIRTUAL_MODELS;
  const normalized = parsed.map((item) => normalizeVirtualModel(item)).filter(Boolean) as VirtualModelDefinition[];
  return normalized.length > 0 ? normalized : fallback;
}

export function getVirtualModels(): VirtualModelDefinition[] {
  return parseVirtualModelsConfig(runtimeConfig.VIRTUAL_MODELS_JSON, DEFAULT_VIRTUAL_MODELS);
}

export function getVirtualModelMap(models = getVirtualModels()) {
  return new Map(models.map((model) => [model.id, model]));
}

export function getRouterPolicyConfig(): RouterPolicyConfig {
  const parsed = parseJsonConfig<any>(runtimeConfig.VIRTUAL_ROUTER_CONFIG_JSON, DEFAULT_ROUTER_POLICY, "VIRTUAL_ROUTER_CONFIG_JSON");
  const premium_model_ids = Array.isArray(parsed?.premium_model_ids)
    ? parsed.premium_model_ids.map((value: any) => String(value || "").trim()).filter(Boolean)
    : DEFAULT_ROUTER_POLICY.premium_model_ids;
  const premium_allowed_groups = Array.isArray(parsed?.premium_allowed_groups)
    ? parsed.premium_allowed_groups.map((value: any) => String(value || "").trim()).filter(Boolean)
    : DEFAULT_ROUTER_POLICY.premium_allowed_groups;
  return {
    premium_model_ids: premium_model_ids.length ? premium_model_ids : DEFAULT_ROUTER_POLICY.premium_model_ids,
    premium_allowed_groups,
    premium_daily_cost_limit: Math.max(0, parseNumber(parsed?.premium_daily_cost_limit, DEFAULT_ROUTER_POLICY.premium_daily_cost_limit)),
    premium_monthly_cost_limit: Math.max(0, parseNumber(parsed?.premium_monthly_cost_limit, DEFAULT_ROUTER_POLICY.premium_monthly_cost_limit)),
  };
}

function extractText(input: any): string[] {
  if (input == null) return [];
  if (typeof input === "string") return [input];
  if (typeof input === "number" || typeof input === "boolean") return [String(input)];
  if (Array.isArray(input)) return input.flatMap((item) => extractText(item));
  if (typeof input === "object") return Object.values(input).flatMap((value) => extractText(value));
  return [];
}

function estimatePromptTokens(body: any) {
  const text = extractText({ prompt: body?.prompt, input: body?.input, messages: body?.messages }).join("\n");
  return text.trim() ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

function deriveTaskSignals(body: any): TaskSignals {
  const fullText = extractText({ prompt: body?.prompt, input: body?.input, messages: body?.messages }).join("\n").toLowerCase();
  const promptTokens = estimatePromptTokens(body);
  const keywordPatterns = [
    /architecture|design|system design|tradeoff|migration/,
    /security|vulnerability|threat|auth|authorization|encryption/,
    /root cause|incident|postmortem|debug|diagnose|failure/,
    /analy[sz]e|compare|evaluate|reason|research/,
  ];
  const keywordScore = keywordPatterns.reduce((score, pattern) => score + (pattern.test(fullText) ? 1 : 0), 0);
  const isCodingTask = /code|bug|fix|refactor|typescript|javascript|sql|query|api|backend|frontend/.test(fullText)
    || Array.isArray(body?.tools)
    || Array.isArray(body?.messages) && body.messages.some((message: any) => typeof message?.content === "string" && /```/.test(message.content));
  const needsLongContext = promptTokens >= 8000 || Array.isArray(body?.messages) && body.messages.length >= 12;
  const needsPremiumReasoning = keywordScore >= 2 || needsLongContext || promptTokens >= 4000;
  return { promptTokens, keywordScore, isCodingTask, needsLongContext, needsPremiumReasoning };
}

function chooseCandidate(definition: VirtualModelDefinition, signals: TaskSignals) {
  switch (definition.strategy) {
    case "cheap_first":
      return definition.candidates[0] || definition.id;
    case "balanced":
      if (signals.needsPremiumReasoning) return definition.candidates[2] || definition.candidates[0] || definition.id;
      return definition.candidates[0] || definition.id;
    case "premium":
      return definition.candidates[0] || definition.id;
    case "code":
      if (signals.needsPremiumReasoning) return definition.candidates[2] || definition.candidates[0] || definition.id;
      return signals.isCodingTask ? (definition.candidates[0] || definition.id) : (definition.candidates[1] || definition.candidates[0] || definition.id);
    case "long_context":
      return signals.needsLongContext ? (definition.candidates[0] || definition.id) : (definition.candidates[1] || definition.candidates[0] || definition.id);
  }
}

export function isVirtualModel(modelName?: string | null) {
  return Boolean(modelName && getVirtualModelMap().has(String(modelName)));
}

export function buildVirtualModelCatalogEntries() {
  return getVirtualModels().map((model) => ({
    id: model.id,
    canonical_slug: model.id,
    name: model.name,
    description: model.description,
    created: VIRTUAL_MODEL_CREATED,
    object: "model",
    owned_by: VIRTUAL_MODEL_OWNER,
    architecture: {
      input_modalities: ["text"],
      output_modalities: ["text"],
      tokenizer: "router",
      instruct_type: null,
    },
    pricing: {
      prompt: "0",
      completion: "0",
      request: "0",
      image: "0",
      web_search: "0",
      internal_reasoning: "0",
      input_cache_read: "0",
      input_cache_write: "0",
    },
    top_provider: {
      is_moderated: false,
      context_length: 0,
      max_completion_tokens: null,
    },
    per_request_limits: null,
    supported_parameters: ["max_tokens", "temperature", "top_p", "tools", "response_format"],
  }));
}

export function injectVirtualModelsIntoCatalog(payload: any) {
  const upstreamModels = Array.isArray(payload?.data) ? payload.data : [];
  const virtualEntries = buildVirtualModelCatalogEntries();
  const seen = new Set<string>();
  const merged = [...virtualEntries, ...upstreamModels].filter((model: any) => {
    const id = String(model?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    ...payload,
    object: payload?.object || "list",
    data: merged,
  };
}

export function evaluatePremiumModelAccess(
  requestedModel: string,
  groups: string[],
  usage: { daily: { cost: number }; monthly: { cost: number } } | null,
  premiumConfig = getRouterPolicyConfig(),
): PremiumAccessDecision {
  if (!premiumConfig.premium_model_ids.includes(requestedModel)) return { allowed: true, premiumConfig };
  const normalizedGroups = groups.map((group) => String(group || "").trim().toLowerCase());
  const allowedGroups = premiumConfig.premium_allowed_groups.map((group) => group.toLowerCase());
  if (allowedGroups.length > 0 && !normalizedGroups.some((group) => allowedGroups.includes(group))) {
    return {
      allowed: false,
      reason: `Premium virtual model requires one of groups: ${premiumConfig.premium_allowed_groups.join(", ")}`,
      premiumConfig,
      groups,
    };
  }

  if (usage && (premiumConfig.premium_daily_cost_limit > 0 || premiumConfig.premium_monthly_cost_limit > 0)) {
    if (premiumConfig.premium_daily_cost_limit > 0 && usage.daily.cost >= premiumConfig.premium_daily_cost_limit) {
      return {
        allowed: false,
        reason: `Premium virtual model daily cost budget exceeded ($${premiumConfig.premium_daily_cost_limit.toFixed(4)})`,
        premiumConfig,
        groups,
        usage,
      };
    }
    if (premiumConfig.premium_monthly_cost_limit > 0 && usage.monthly.cost >= premiumConfig.premium_monthly_cost_limit) {
      return {
        allowed: false,
        reason: `Premium virtual model monthly cost budget exceeded ($${premiumConfig.premium_monthly_cost_limit.toFixed(4)})`,
        premiumConfig,
        groups,
        usage,
      };
    }
    return { allowed: true, premiumConfig, groups, usage };
  }

  return { allowed: true, premiumConfig, groups };
}

export async function checkVirtualModelAccess(userId: string | null, requestedModel: string): Promise<PremiumAccessDecision> {
  const premiumConfig = getRouterPolicyConfig();
  if (!premiumConfig.premium_model_ids.includes(requestedModel)) return { allowed: true, premiumConfig };
  if (!userId) {
    return { allowed: false, reason: "Premium virtual model requires authenticated user", premiumConfig, groups: [] };
  }

  const groups = await getUserGroups(userId);
  const usage = (premiumConfig.premium_daily_cost_limit > 0 || premiumConfig.premium_monthly_cost_limit > 0)
    ? await getUsageSnapshotAll(userId, true)
    : null;
  return evaluatePremiumModelAccess(requestedModel, groups, usage, premiumConfig);
}

export function resolveVirtualModelWithDefinitions(modelName: string, body: any, definitions: VirtualModelDefinition[]) {
  const definition = getVirtualModelMap(definitions).get(modelName);
  if (!definition) {
    return {
      requestedModel: modelName,
      resolvedModel: modelName,
      usedVirtualModel: false,
      reason: "raw_model_passthrough",
      signals: deriveTaskSignals(body),
    };
  }

  const signals = deriveTaskSignals(body);
  const resolvedModel = chooseCandidate(definition, signals);
  const reasons: string[] = [definition.strategy];
  if (signals.isCodingTask) reasons.push("coding_task");
  if (signals.needsLongContext) reasons.push("long_context");
  if (signals.needsPremiumReasoning) reasons.push("premium_reasoning");
  if (signals.keywordScore > 0) reasons.push(`keyword_score:${signals.keywordScore}`);
  if (signals.promptTokens > 0) reasons.push(`prompt_tokens:${signals.promptTokens}`);

  return {
    requestedModel: modelName,
    resolvedModel,
    usedVirtualModel: true,
    reason: reasons.join(","),
    signals,
  };
}

export function resolveVirtualModel(modelName: string, body: any) {
  return resolveVirtualModelWithDefinitions(modelName, body, getVirtualModels());
}
