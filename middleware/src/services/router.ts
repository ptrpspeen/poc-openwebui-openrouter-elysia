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
  languageHint: "thai" | "english" | "mixed" | "unknown";
  matchedSignals: string[];
  confidence: number;
  hybridClassifierRecommended: boolean;
  hybridClassifierUsed: boolean;
  hybridClassifierModel?: string;
  hybridTaskType?: string;
  hybridComplexity?: string;
  hybridConfidence?: number;
  hybridReason?: string;
};

type RouterPolicyConfig = {
  premium_model_ids: string[];
  premium_allowed_groups: string[];
  premium_daily_cost_limit: number;
  premium_monthly_cost_limit: number;
  hybrid_classifier_enabled: boolean;
  hybrid_classifier_model: string;
  hybrid_confidence_threshold: number;
  hybrid_classifier_timeout_ms: number;
  hybrid_classifier_cache_ttl_ms: number;
};

type HybridRouteClassification = {
  task_type?: string;
  complexity?: "simple" | "standard" | "complex" | string;
  needs_code?: boolean;
  needs_long_context?: boolean;
  needs_premium_reasoning?: boolean;
  confidence?: number;
  reason?: string;
};

export type RouterSignalRule = {
  label: string;
  description: string;
  keywords: string[];
  weight: number;
  coding: boolean;
};

export type RouterRulesConfig = {
  premium_keyword_score: number;
  long_context_tokens: number;
  premium_prompt_tokens: number;
  signal_rules: RouterSignalRule[];
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
  hybrid_classifier_enabled: false,
  hybrid_classifier_model: "openai/gpt-4.1-nano",
  hybrid_confidence_threshold: 0.55,
  hybrid_classifier_timeout_ms: 1000,
  hybrid_classifier_cache_ttl_ms: 300000,
};

export const DEFAULT_ROUTER_RULES: RouterRulesConfig = {
  premium_keyword_score: 2,
  long_context_tokens: 8000,
  premium_prompt_tokens: 4000,
  signal_rules: [
    {
      label: "architecture",
      description: "Architecture, design, tradeoff, and migration work.",
      weight: 1,
      coding: false,
      keywords: ["architecture", "design", "system design", "tradeoff", "migration", "สถาปัตยกรรม", "ออกแบบระบบ", "ออกแบบ", "โครงสร้างระบบ", "ย้ายระบบ", "ไมเกรต", "ข้อดีข้อเสีย", "เปรียบเทียบทางเลือก"],
    },
    {
      label: "security",
      description: "Security, vulnerability, auth, and threat analysis.",
      weight: 1,
      coding: false,
      keywords: ["security", "vulnerability", "threat", "auth", "authorization", "encryption", "ความปลอดภัย", "ช่องโหว่", "ภัยคุกคาม", "ยืนยันตัวตน", "สิทธิ์", "เข้ารหัส", "แฮก", "โจมตี"],
    },
    {
      label: "root_cause_debug",
      description: "Root cause, incident, debugging, and failure diagnosis.",
      weight: 1,
      coding: false,
      keywords: ["root cause", "incident", "postmortem", "debug", "diagnose", "failure", "สาเหตุ", "ต้นเหตุ", "หาสาเหตุ", "วิเคราะห์ปัญหา", "ดีบัก", "บั๊ก", "แก้บั๊ก", "ระบบล่ม", "ล้มเหลว", "ใช้งานไม่ได้"],
    },
    {
      label: "analysis_research",
      description: "Analysis, comparison, evaluation, reasoning, and research.",
      weight: 1,
      coding: false,
      keywords: ["analyze", "analyse", "compare", "evaluate", "reason", "research", "วิเคราะห์", "เปรียบเทียบ", "ประเมิน", "ให้เหตุผล", "วิจัย", "สรุปเชิงลึก", "อธิบายเหตุผล"],
    },
    {
      label: "coding",
      description: "Programming, API, database, frontend/backend, and refactoring tasks.",
      weight: 0,
      coding: true,
      keywords: ["code", "bug", "fix", "refactor", "typescript", "javascript", "sql", "query", "api", "backend", "frontend", "โค้ด", "เขียนโปรแกรม", "โปรแกรม", "แก้โค้ด", "รีแฟกเตอร์", "ฐานข้อมูล", "คิวรี่", "เอพีไอ", "หน้าบ้าน", "หลังบ้าน", "ฟรอนต์เอนด์", "แบ็กเอนด์"],
    },
  ],
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
    hybrid_classifier_enabled: Boolean(parsed?.hybrid_classifier_enabled ?? DEFAULT_ROUTER_POLICY.hybrid_classifier_enabled),
    hybrid_classifier_model: String(parsed?.hybrid_classifier_model || DEFAULT_ROUTER_POLICY.hybrid_classifier_model),
    hybrid_confidence_threshold: Math.min(1, Math.max(0, parseNumber(parsed?.hybrid_confidence_threshold, DEFAULT_ROUTER_POLICY.hybrid_confidence_threshold))),
    hybrid_classifier_timeout_ms: Math.max(100, parseNumber(parsed?.hybrid_classifier_timeout_ms, DEFAULT_ROUTER_POLICY.hybrid_classifier_timeout_ms)),
    hybrid_classifier_cache_ttl_ms: Math.max(0, parseNumber(parsed?.hybrid_classifier_cache_ttl_ms, DEFAULT_ROUTER_POLICY.hybrid_classifier_cache_ttl_ms)),
  };
}

function normalizeSignalRule(input: any): RouterSignalRule | null {
  const label = String(input?.label || "").trim();
  const keywords = Array.isArray(input?.keywords) ? input.keywords.map((value: any) => String(value || "").trim().toLowerCase()).filter(Boolean) : [];
  if (!label || !keywords.length) return null;
  return {
    label,
    description: String(input?.description || "").trim(),
    keywords,
    weight: Math.max(0, parseNumber(input?.weight, 1)),
    coding: Boolean(input?.coding),
  };
}

export function getRouterRulesConfig(): RouterRulesConfig {
  const parsed = parseJsonConfig<any>(runtimeConfig.VIRTUAL_ROUTER_RULES_JSON, DEFAULT_ROUTER_RULES, "VIRTUAL_ROUTER_RULES_JSON");
  const signal_rules = Array.isArray(parsed?.signal_rules)
    ? parsed.signal_rules.map((rule: any) => normalizeSignalRule(rule)).filter(Boolean) as RouterSignalRule[]
    : DEFAULT_ROUTER_RULES.signal_rules;
  return {
    premium_keyword_score: Math.max(0, parseNumber(parsed?.premium_keyword_score, DEFAULT_ROUTER_RULES.premium_keyword_score)),
    long_context_tokens: Math.max(1, parseNumber(parsed?.long_context_tokens, DEFAULT_ROUTER_RULES.long_context_tokens)),
    premium_prompt_tokens: Math.max(1, parseNumber(parsed?.premium_prompt_tokens, DEFAULT_ROUTER_RULES.premium_prompt_tokens)),
    signal_rules: signal_rules.length ? signal_rules : DEFAULT_ROUTER_RULES.signal_rules,
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

function inferLanguageHint(text: string): TaskSignals["languageHint"] {
  const thaiChars = (text.match(/[\u0E00-\u0E7F]/g) || []).length;
  const englishChars = (text.match(/[a-z]/gi) || []).length;
  if (thaiChars > 0 && englishChars > 0) {
    if (thaiChars >= englishChars * 2) return "thai";
    if (englishChars >= thaiChars * 2) return "english";
    return "mixed";
  }
  if (thaiChars > 0) return "thai";
  if (englishChars > 0) return "english";
  return "unknown";
}

function deriveTaskSignals(body: any): TaskSignals {
  const fullText = extractText({ prompt: body?.prompt, input: body?.input, messages: body?.messages }).join("\n").toLowerCase();
  const promptTokens = estimatePromptTokens(body);
  const languageHint = inferLanguageHint(fullText);
  const rules = getRouterRulesConfig();
  const matchedRules = rules.signal_rules.filter((rule) => rule.keywords.some((keyword) => fullText.includes(keyword.toLowerCase())));
  const matchedSignals = matchedRules.map((rule) => rule.label);
  const codingSignals = matchedRules.filter((rule) => rule.coding).map((rule) => rule.label);
  if (Array.isArray(body?.tools)) codingSignals.push("tools");
  if (Array.isArray(body?.messages) && body.messages.some((message: any) => typeof message?.content === "string" && /```/.test(message.content))) codingSignals.push("code_block");
  const keywordScore = matchedRules.reduce((score, rule) => score + rule.weight, 0);
  const isCodingTask = codingSignals.length > 0;
  const needsLongContext = promptTokens >= rules.long_context_tokens || Array.isArray(body?.messages) && body.messages.length >= 12;
  const needsPremiumReasoning = keywordScore >= rules.premium_keyword_score || needsLongContext || promptTokens >= rules.premium_prompt_tokens;
  const confidence = Math.min(1, Math.max(
    keywordScore > 0 ? 0.35 + keywordScore * 0.18 : 0,
    isCodingTask ? 0.6 : 0,
    needsLongContext ? 0.85 : 0,
    promptTokens >= 4000 ? 0.75 : 0,
  ));
  const hybridClassifierRecommended = confidence < getRouterPolicyConfig().hybrid_confidence_threshold && promptTokens > 0;
  return {
    promptTokens,
    keywordScore,
    isCodingTask,
    needsLongContext,
    needsPremiumReasoning,
    languageHint,
    matchedSignals: [...new Set([...matchedSignals, ...codingSignals])],
    confidence,
    hybridClassifierRecommended,
    hybridClassifierUsed: false,
  };
}

const hybridClassifierCache = new Map<string, { expiresAt: number; value: HybridRouteClassification | null }>();

function hashForCache(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function normalizeHybridClassification(input: any): HybridRouteClassification | null {
  if (!input || typeof input !== "object") return null;
  const confidence = Math.min(1, Math.max(0, parseNumber(input.confidence, 0)));
  return {
    task_type: input.task_type ? String(input.task_type) : undefined,
    complexity: input.complexity ? String(input.complexity) : undefined,
    needs_code: Boolean(input.needs_code),
    needs_long_context: Boolean(input.needs_long_context),
    needs_premium_reasoning: Boolean(input.needs_premium_reasoning),
    confidence,
    reason: input.reason ? String(input.reason).slice(0, 500) : undefined,
  };
}

function mergeHybridSignals(signals: TaskSignals, classification: HybridRouteClassification | null, policy: RouterPolicyConfig): TaskSignals {
  if (!classification) return signals;
  const hybridConfidence = Math.min(1, Math.max(0, classification.confidence || 0));
  if (hybridConfidence < policy.hybrid_confidence_threshold) {
    return {
      ...signals,
      hybridClassifierUsed: true,
      hybridClassifierModel: policy.hybrid_classifier_model,
      hybridTaskType: classification.task_type,
      hybridComplexity: classification.complexity,
      hybridConfidence,
      hybridReason: classification.reason,
    };
  }
  const matchedSignals = [...signals.matchedSignals];
  if (classification.task_type) matchedSignals.push(`llm:${classification.task_type}`);
  if (classification.complexity) matchedSignals.push(`llm_complexity:${classification.complexity}`);
  return {
    ...signals,
    isCodingTask: signals.isCodingTask || Boolean(classification.needs_code),
    needsLongContext: signals.needsLongContext || Boolean(classification.needs_long_context),
    needsPremiumReasoning: signals.needsPremiumReasoning || Boolean(classification.needs_premium_reasoning) || classification.complexity === "complex",
    matchedSignals: [...new Set(matchedSignals)],
    confidence: Math.max(signals.confidence, hybridConfidence),
    hybridClassifierUsed: true,
    hybridClassifierModel: policy.hybrid_classifier_model,
    hybridTaskType: classification.task_type,
    hybridComplexity: classification.complexity,
    hybridConfidence,
    hybridReason: classification.reason,
  };
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

export async function classifyRouteWithHybridLLM(body: any, policy = getRouterPolicyConfig()): Promise<HybridRouteClassification | null> {
  if (!policy.hybrid_classifier_enabled || !runtimeConfig.OPENROUTER_API_KEY) return null;
  const text = extractText({ prompt: body?.prompt, input: body?.input, messages: body?.messages }).join("\n").slice(0, 4000);
  if (!text.trim()) return null;
  const cacheKey = `${policy.hybrid_classifier_model}:${hashForCache(text)}`;
  const cached = hybridClassifierCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.hybrid_classifier_timeout_ms);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${runtimeConfig.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: policy.hybrid_classifier_model,
        temperature: 0,
        max_tokens: 120,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Classify Thai/English user prompts for LLM routing. Return compact JSON with task_type, complexity(simple|standard|complex), needs_code, needs_long_context, confidence(0-1), reason." },
          { role: "user", content: text },
        ],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const parsed = normalizeHybridClassification(JSON.parse(payload?.choices?.[0]?.message?.content || "null"));
    if (policy.hybrid_classifier_cache_ttl_ms > 0) {
      hybridClassifierCache.set(cacheKey, { value: parsed, expiresAt: Date.now() + policy.hybrid_classifier_cache_ttl_ms });
    }
    return parsed;
  } catch (error: any) {
    writeSystemLog("warn", "Hybrid route classifier failed; falling back to rules", { error: error?.message || String(error) });
    return null;
  } finally {
    clearTimeout(timeout);
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

function buildRoutingDecision(modelName: string, body: any, definitions: VirtualModelDefinition[], signals: TaskSignals) {
  const definition = getVirtualModelMap(definitions).get(modelName);
  if (!definition) {
    return {
      requestedModel: modelName,
      resolvedModel: modelName,
      usedVirtualModel: false,
      reason: "raw_model_passthrough",
      signals,
    };
  }

  const resolvedModel = chooseCandidate(definition, signals);
  const reasons: string[] = [definition.strategy];
  if (signals.isCodingTask) reasons.push("coding_task");
  if (signals.needsLongContext) reasons.push("long_context");
  if (signals.needsPremiumReasoning) reasons.push("premium_reasoning");
  if (signals.hybridClassifierRecommended) reasons.push("hybrid_recommended");
  if (signals.hybridClassifierUsed) reasons.push("hybrid_used");
  if (signals.hybridTaskType) reasons.push(`llm_task:${signals.hybridTaskType}`);
  if (signals.hybridComplexity) reasons.push(`llm_complexity:${signals.hybridComplexity}`);
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

export function resolveVirtualModelWithDefinitions(modelName: string, body: any, definitions: VirtualModelDefinition[]) {
  return buildRoutingDecision(modelName, body, definitions, deriveTaskSignals(body));
}

export async function resolveVirtualModelWithHybridDefinitions(modelName: string, body: any, definitions: VirtualModelDefinition[]) {
  const baseSignals = deriveTaskSignals(body);
  const policy = getRouterPolicyConfig();
  let signals = baseSignals;
  if (policy.hybrid_classifier_enabled && baseSignals.hybridClassifierRecommended) {
    signals = mergeHybridSignals(baseSignals, await classifyRouteWithHybridLLM(body, policy), policy);
  }
  return buildRoutingDecision(modelName, body, definitions, signals);
}

export function resolveVirtualModel(modelName: string, body: any) {
  return resolveVirtualModelWithDefinitions(modelName, body, getVirtualModels());
}

export async function resolveVirtualModelHybrid(modelName: string, body: any) {
  return resolveVirtualModelWithHybridDefinitions(modelName, body, getVirtualModels());
}
