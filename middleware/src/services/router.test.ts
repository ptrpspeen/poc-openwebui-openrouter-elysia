import { afterEach, describe, expect, it } from "bun:test";
import { runtimeConfig } from "./config";
import {
  DEFAULT_ROUTER_POLICY,
  buildVirtualModelCatalogEntries,
  evaluatePremiumModelAccess,
  getRouterPolicyConfig,
  getRouterRulesConfig,
  getVirtualModels,
  injectVirtualModelsIntoCatalog,
  isVirtualModel,
  parseVirtualModelsConfig,
  resolveVirtualModel,
  resolveVirtualModelWithDefinitions,
} from "./router";

const originalVirtualModelsJson = runtimeConfig.VIRTUAL_MODELS_JSON;
const originalRouterConfigJson = runtimeConfig.VIRTUAL_ROUTER_CONFIG_JSON;
const originalRouterRulesJson = runtimeConfig.VIRTUAL_ROUTER_RULES_JSON;

afterEach(() => {
  runtimeConfig.VIRTUAL_MODELS_JSON = originalVirtualModelsJson;
  runtimeConfig.VIRTUAL_ROUTER_CONFIG_JSON = originalRouterConfigJson;
  runtimeConfig.VIRTUAL_ROUTER_RULES_JSON = originalRouterRulesJson;
});

describe("router helpers", () => {
  it("marks configured virtual models", () => {
    expect(isVirtualModel("virtual/auto-fast")).toBe(true);
    expect(isVirtualModel("openai/gpt-4.1")).toBe(false);
  });

  it("prepends virtual models without dropping upstream models", () => {
    const payload = injectVirtualModelsIntoCatalog({
      data: [
        { id: "openai/gpt-4.1", name: "GPT-4.1" },
        { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      ],
    });

    const entries = buildVirtualModelCatalogEntries();
    expect(payload.data[0].id).toBe(entries[0].id);
    expect(payload.data.some((model: any) => model.id === "openai/gpt-4.1")).toBe(true);
    expect(payload.data.some((model: any) => model.id === "virtual/auto-balanced")).toBe(true);
  });

  it("supports virtual model overrides from runtime config", () => {
    runtimeConfig.VIRTUAL_MODELS_JSON = JSON.stringify([
      {
        id: "virtual/custom-review",
        name: "Custom Review",
        description: "Custom review route",
        strategy: "balanced",
        candidates: ["openai/gpt-4.1-mini", "google/gemini-2.5-flash", "anthropic/claude-3.7-sonnet"],
      },
    ]);

    const models = getVirtualModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("virtual/custom-review");
    expect(isVirtualModel("virtual/custom-review")).toBe(true);
  });

  it("routes balanced virtual model to premium candidate for harder tasks", () => {
    const resolution = resolveVirtualModel("virtual/auto-balanced", {
      messages: [
        {
          role: "user",
          content: "Please analyze this system architecture, compare tradeoffs, and give a root cause assessment for the incident.",
        },
      ],
    });

    expect(resolution.usedVirtualModel).toBe(true);
    expect(resolution.resolvedModel).toBe("anthropic/claude-3.7-sonnet");
    expect(resolution.reason).toContain("premium_reasoning");
  });

  it("routes code virtual model to code-oriented candidate", () => {
    const resolution = resolveVirtualModel("virtual/auto-code", {
      messages: [
        {
          role: "user",
          content: "Debug this TypeScript API bug and refactor the handler.",
        },
      ],
    });

    expect(resolution.resolvedModel).toBe("anthropic/claude-3.7-sonnet");
    expect(resolution.reason).toContain("coding_task");
  });

  it("previews routing against unsaved virtual model definitions", () => {
    const definitions = parseVirtualModelsConfig(JSON.stringify([
      {
        id: "virtual/custom-code",
        name: "Custom Code",
        description: "Preview custom route",
        strategy: "code",
        candidates: ["cheap/code-model", "cheap/general-model", "premium/code-model"],
      },
    ]));

    const resolution = resolveVirtualModelWithDefinitions("virtual/custom-code", {
      messages: [{ role: "user", content: "Debug this backend TypeScript API, review the security architecture, and explain the root cause." }],
    }, definitions);

    expect(resolution.usedVirtualModel).toBe(true);
    expect(resolution.resolvedModel).toBe("premium/code-model");
    expect(resolution.reason).toContain("coding_task");
    expect(resolution.signals.promptTokens).toBeGreaterThan(0);
  });

  it("detects Thai analysis, debugging, security, and coding signals", () => {
    const resolution = resolveVirtualModel("virtual/auto-balanced", {
      messages: [{ role: "user", content: "ช่วยวิเคราะห์สาเหตุระบบล่ม ตรวจความปลอดภัยเอพีไอ และแก้บั๊กหลังบ้านให้หน่อย" }],
    });

    expect(resolution.usedVirtualModel).toBe(true);
    expect(resolution.resolvedModel).toBe("anthropic/claude-3.7-sonnet");
    expect(resolution.signals.languageHint).toBe("thai");
    expect(resolution.signals.isCodingTask).toBe(true);
    expect(resolution.signals.needsPremiumReasoning).toBe(true);
    expect(resolution.signals.matchedSignals).toContain("root_cause_debug");
    expect(resolution.signals.matchedSignals).toContain("security");
  });

  it("allows admins to configure rule-builder keywords and thresholds", () => {
    runtimeConfig.VIRTUAL_ROUTER_RULES_JSON = JSON.stringify({
      premium_keyword_score: 1.5,
      long_context_tokens: 8000,
      premium_prompt_tokens: 4000,
      signal_rules: [
        { label: "thai_procurement", description: "Procurement work", weight: 2, coding: false, keywords: ["จัดซื้อ", "TOR"] },
      ],
    });

    const rules = getRouterRulesConfig();
    expect(rules.signal_rules[0].label).toBe("thai_procurement");

    const resolution = resolveVirtualModel("virtual/auto-balanced", {
      messages: [{ role: "user", content: "ช่วยวิเคราะห์ TOR งานจัดซื้อระบบ AI ให้หน่อย" }],
    });

    expect(resolution.resolvedModel).toBe("anthropic/claude-3.7-sonnet");
    expect(resolution.signals.matchedSignals).toContain("thai_procurement");
    expect(resolution.signals.keywordScore).toBe(2);
  });

  it("exposes hybrid classifier config while keeping it off by default", () => {
    const defaultConfig = getRouterPolicyConfig();
    expect(defaultConfig.hybrid_classifier_enabled).toBe(false);
    expect(defaultConfig.hybrid_classifier_model).toBe("openai/gpt-4.1-nano");

    runtimeConfig.VIRTUAL_ROUTER_CONFIG_JSON = JSON.stringify({
      ...DEFAULT_ROUTER_POLICY,
      hybrid_classifier_enabled: true,
      hybrid_classifier_model: "openai/gpt-4.1-mini",
      hybrid_confidence_threshold: 0.7,
    });
    const config = getRouterPolicyConfig();
    expect(config.hybrid_classifier_enabled).toBe(true);
    expect(config.hybrid_classifier_model).toBe("openai/gpt-4.1-mini");
    expect(config.hybrid_confidence_threshold).toBe(0.7);
  });

  it("blocks premium virtual model when group gate fails", () => {
    const config = getRouterPolicyConfig();
    const decision = evaluatePremiumModelAccess("virtual/auto-best", ["students"], null, {
      ...config,
      premium_allowed_groups: ["admin", "research"],
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("requires one of groups");
  });

  it("blocks premium virtual model when budget gate fails", () => {
    const decision = evaluatePremiumModelAccess("virtual/auto-best", ["admin"], {
      daily: { cost: 1.2 },
      monthly: { cost: 4.5 },
    }, {
      ...DEFAULT_ROUTER_POLICY,
      premium_model_ids: ["virtual/auto-best"],
      premium_allowed_groups: ["admin"],
      premium_daily_cost_limit: 1,
      premium_monthly_cost_limit: 10,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("daily cost budget exceeded");
  });
});
