import { afterEach, describe, expect, it } from "bun:test";
import { runtimeConfig } from "./config";
import {
  buildVirtualModelCatalogEntries,
  evaluatePremiumModelAccess,
  getRouterPolicyConfig,
  getVirtualModels,
  injectVirtualModelsIntoCatalog,
  isVirtualModel,
  resolveVirtualModel,
} from "./router";

const originalVirtualModelsJson = runtimeConfig.VIRTUAL_MODELS_JSON;
const originalRouterConfigJson = runtimeConfig.VIRTUAL_ROUTER_CONFIG_JSON;

afterEach(() => {
  runtimeConfig.VIRTUAL_MODELS_JSON = originalVirtualModelsJson;
  runtimeConfig.VIRTUAL_ROUTER_CONFIG_JSON = originalRouterConfigJson;
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
      premium_model_ids: ["virtual/auto-best"],
      premium_allowed_groups: ["admin"],
      premium_daily_cost_limit: 1,
      premium_monthly_cost_limit: 10,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("daily cost budget exceeded");
  });
});
