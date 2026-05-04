import { afterEach, describe, expect, it } from "bun:test";
import {
  calculateEstimatedCostFromPricing,
  estimateUsageFromRequestBody,
  estimateReservedUsage,
  isModelAllowed,
  streamWithUsageTracking,
} from "./quota";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("quota helpers", () => {
  it("matches allowed_models with wildcard patterns", () => {
    expect(isModelAllowed({ allowed_models: "openai/*,anthropic/claude-*" }, "openai/gpt-4.1")).toBe(true);
    expect(isModelAllowed({ allowed_models: "openai/*,anthropic/claude-*" }, "anthropic/claude-3.7-sonnet")).toBe(true);
    expect(isModelAllowed({ allowed_models: "openai/*,anthropic/claude-*" }, "google/gemini-2.5-pro")).toBe(false);
  });

  it("estimates reservation tokens from prompt and output budget", () => {
    const usage = estimateUsageFromRequestBody({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Summarize this paragraph in Thai." },
      ],
      max_tokens: 512,
    });

    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBe(512);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + 512);
  });

  it("adds safety margin when estimating cost from pricing", () => {
    const cost = calculateEstimatedCostFromPricing(
      { prompt: "0.000001", completion: "0.000002" },
      { prompt_tokens: 1000, completion_tokens: 500 }
    );

    expect(cost).toBeCloseTo((1000 * 0.000001 + 500 * 0.000002) * 1.15, 12);
  });

  it("includes web search and cache write pricing in reserved estimate", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        data: [{
          id: "openai/gpt-4.1",
          pricing: {
            prompt: "0.000001",
            completion: "0.000002",
            web_search: "0.01",
            input_cache_write: "0.00000125",
          },
          top_provider: { max_completion_tokens: 4096 },
        }],
      }));
    }) as unknown as typeof fetch;

    const usage = await estimateReservedUsage("openai/gpt-4.1:online", {
      model: "openai/gpt-4.1:online",
      messages: [{ role: "user", content: "hello world" }],
      max_tokens: 100,
      cache_control: { type: "ephemeral" },
      plugins: [{ id: "web", engine: "native" }],
    });

    expect(usage.total_tokens).toBeGreaterThan(0);
    expect(usage.total_cost).toBeGreaterThan(0.01);
  });

  it("fires missing-usage hook when stream ends without usage payload", async () => {
    let missingUsageCalled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"id\":\"evt_1\"}\n\n"));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const response = new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });

    for await (const _chunk of streamWithUsageTracking(response, null, {
      onMissingUsage: async () => {
        missingUsageCalled = true;
      },
    })) {
      // drain stream
    }

    expect(missingUsageCalled).toBe(true);
  });

  it("fires usage hook when stream includes usage payload", async () => {
    let usageCalled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"model\":\"openai/gpt-4.1\",\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}\n\n"));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const response = new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });

    for await (const _chunk of streamWithUsageTracking(response, null, {
      onUsage: async () => {
        usageCalled = true;
      },
    })) {
      // drain stream
    }

    expect(usageCalled).toBe(true);
  });
});
