import { Elysia } from "elysia";
import { runtimeConfig, writeSystemLog } from "../services/config";
import {
  getUserFromJWT,
  ensureUserExists,
  checkAccess,
  estimateReservedUsage,
  reserveUsageEstimate,
  releaseUsageEstimate,
  processUsage,
  logRequestPerformance,
  streamWithUsageTracking,
} from "../services/quota";
import { checkVirtualModelAccess, injectVirtualModelsIntoCatalog, resolveVirtualModel } from "../services/router";

const OPENROUTER_BASE = "https://openrouter.ai/api";

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const STRIP_REQUEST_HEADERS = new Set([
  "cookie", "authorization", "x-forwarded-for", "x-real-ip",
  "x-forwarded-proto", "x-forwarded-host", "accept-encoding", "host", "content-length",
  "x-openwebui-user-email", "x-openwebui-user-id",
]);

function cleanRequestHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (!STRIP_REQUEST_HEADERS.has(lowerKey) && !HOP_BY_HOP_HEADERS.has(lowerKey)) {
      result[key] = value;
    }
  });
  return result;
}

export function cleanResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && lowerKey !== "content-length" && lowerKey !== "content-encoding") {
      result[key] = value;
    }
  });
  return result;
}

function classifyUpstreamError(status: number, payload: any) {
  const rawMessage = payload?.error?.message || payload?.message || payload?.error || "Upstream request failed";
  const message = String(rawMessage || "Upstream request failed");
  const lower = message.toLowerCase();

  if (status === 401 || status === 403) {
    if (lower.includes("user not found") || lower.includes("invalid api key") || lower.includes("incorrect api key") || lower.includes("unauthorized")) {
      return {
        error: "Upstream API key is invalid or not linked to a valid account",
        code: "UPSTREAM_INVALID_API_KEY",
        upstream: { status, message },
      };
    }
  }

  return { error: message, code: "UPSTREAM_ERROR", upstream: { status, message } };
}

export const proxyRoutes = new Elysia()
  .all("/v1/*", async ({ request, params, set }) => {
    const requestStartedAt = new Date();
    let usageReservation: { userId: string; usage: { total_tokens: number; total_cost: number }; now: Date } | null = null;

    if (!runtimeConfig.OPENROUTER_API_KEY) {
      set.status = 500;
      return "OPENROUTER_API_KEY not set";
    }

    const path = (params as { "*": string })["*"];

    // Inject virtual models while preserving upstream models for safety.
    if (path === "models" && request.method === "GET") {
      const upstreamResponse = await fetch(`${OPENROUTER_BASE}/v1/models`, {
        headers: { Authorization: `Bearer ${runtimeConfig.OPENROUTER_API_KEY}`, Accept: "application/json" },
      });
      const responseHeaders = cleanResponseHeaders(upstreamResponse.headers);
      logRequestPerformance({
        userId: null, model: "models", path, method: request.method,
        status: upstreamResponse.status, isStream: false,
        startedAt: requestStartedAt, completedAt: new Date(), totalCost: 0,
      });

      if (!upstreamResponse.ok) {
        return new Response(await upstreamResponse.arrayBuffer(), {
          status: upstreamResponse.status,
          headers: responseHeaders,
        });
      }

      const upstreamPayload = await upstreamResponse.json();
      const mergedPayload = injectVirtualModelsIntoCatalog(upstreamPayload);
      return new Response(JSON.stringify(mergedPayload), {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    }

    // ── Identify user ────────────────────────────────────────────────────────
    // Primary: x-openwebui-* headers set by OpenWebUI within Docker network.
    // Fallback: Bearer JWT verified with WEBUI_SECRET_KEY (disabled if key not set).
    let rawUserId = request.headers.get("x-openwebui-user-email") || request.headers.get("x-openwebui-user-id");
    let userId: string | null = rawUserId ? rawUserId.toLowerCase().trim() : null;

    if (!userId) {
      const authHeader = request.headers.get("authorization") || "";
      if (authHeader.startsWith("Bearer ")) {
        userId = await getUserFromJWT(authHeader.split(" ")[1]);
      }
    }

    if (userId) await ensureUserExists(userId);

    // ── Quota check (POST only) ──────────────────────────────────────────────
    let body: any = null;
    let modelName = "unknown";
    let requestedModelName = "unknown";
    let routingDecision: ReturnType<typeof resolveVirtualModel> | null = null;
    if (request.method === "POST" && request.headers.get("content-type")?.includes("application/json")) {
      body = await request.json();
      requestedModelName = body.model || "unknown";
      const virtualAccess = await checkVirtualModelAccess(userId, requestedModelName);
      if (!virtualAccess.allowed) {
        logRequestPerformance({
          userId, model: requestedModelName || body.model || "", path, method: request.method,
          status: 403, isStream: Boolean(body.stream),
          startedAt: requestStartedAt, completedAt: new Date(),
          totalCost: 0,
          deniedReason: virtualAccess.reason || "Virtual model access denied",
          deniedCategory: "virtual_model_gate",
          requestedModel: requestedModelName || body.model || "",
          resolvedModel: null,
          routingReason: "premium_virtual_gate_denied",
        });
        set.status = 403;
        return {
          error: virtualAccess.reason || "Virtual model access denied",
          groups: virtualAccess.groups || [],
          premiumConfig: virtualAccess.premiumConfig,
          usage: virtualAccess.usage || null,
        };
      }
      routingDecision = resolveVirtualModel(requestedModelName, body);
      modelName = routingDecision.resolvedModel || requestedModelName;
      if (routingDecision.usedVirtualModel) {
        body.model = modelName;
        writeSystemLog("info", "Resolved virtual model request", {
          path,
          requestedModel: routingDecision.requestedModel,
          resolvedModel: routingDecision.resolvedModel,
          reason: routingDecision.reason,
          userId,
        });
      }

      if (userId) {
        const access = await checkAccess(userId, modelName);
        if (!access.allowed) {
          const deniedReason = access.reason || "Quota exceeded";
          const deniedCategory =
            deniedReason.toLowerCase().includes("daily token") ? "daily_token" :
            deniedReason.toLowerCase().includes("monthly token") ? "monthly_token" :
            deniedReason.toLowerCase().includes("daily cost") ? "daily_cost" :
            deniedReason.toLowerCase().includes("monthly cost") ? "monthly_cost" :
            deniedReason.toLowerCase().includes("formula") ? "formula" : "quota";

          logRequestPerformance({
            userId, model: requestedModelName || body.model || "", path, method: request.method,
            status: 403, isStream: Boolean(body.stream),
            startedAt: requestStartedAt, completedAt: new Date(),
            totalCost: 0, deniedReason, deniedCategory,
            requestedModel: requestedModelName || body.model || "",
            resolvedModel: modelName,
            routingReason: routingDecision?.reason || null,
          });
          set.status = 403;
          return { error: deniedReason, policy: access.policy, usage: access.usage, details: access.details, groups: access.groups };
        }

        const estimatedUsage = await estimateReservedUsage(modelName, body);
        usageReservation = await reserveUsageEstimate(userId, estimatedUsage);
        const accessWithReservation = await checkAccess(userId, modelName);
        if (!accessWithReservation.allowed) {
          await releaseUsageEstimate(usageReservation);
          usageReservation = null;
          const deniedReason = accessWithReservation.reason || "Quota exceeded";
          const deniedCategory =
            deniedReason.toLowerCase().includes("daily token") ? "daily_token" :
            deniedReason.toLowerCase().includes("monthly token") ? "monthly_token" :
            deniedReason.toLowerCase().includes("daily cost") ? "daily_cost" :
            deniedReason.toLowerCase().includes("monthly cost") ? "monthly_cost" :
            deniedReason.toLowerCase().includes("formula") ? "formula" : "quota";

          logRequestPerformance({
            userId, model: requestedModelName || body.model || "", path, method: request.method,
            status: 403, isStream: Boolean(body.stream),
            startedAt: requestStartedAt, completedAt: new Date(),
            totalCost: 0, deniedReason, deniedCategory,
            requestedModel: requestedModelName || body.model || "",
            resolvedModel: modelName,
            routingReason: routingDecision?.reason || null,
          });
          set.status = 403;
          return {
            error: deniedReason,
            policy: accessWithReservation.policy,
            usage: accessWithReservation.usage,
            details: accessWithReservation.details,
            groups: accessWithReservation.groups,
          };
        }
      }
    }

    try {
      // ── Forward to OpenRouter ──────────────────────────────────────────────
      const headers = cleanRequestHeaders(request.headers);
      if (routingDecision?.usedVirtualModel) {
        headers["X-AICP-Virtual-Model"] = routingDecision.requestedModel;
        headers["X-AICP-Resolved-Model"] = routingDecision.resolvedModel;
      }
      headers["Authorization"] = `Bearer ${runtimeConfig.OPENROUTER_API_KEY}`;
      headers["User-Agent"] = request.headers.get("user-agent") || "OpenWebUI-Middleware/1.0";
      if (runtimeConfig.OPENROUTER_HTTP_REFERER) headers["HTTP-Referer"] = runtimeConfig.OPENROUTER_HTTP_REFERER;
      if (runtimeConfig.OPENROUTER_X_TITLE) headers["X-Title"] = runtimeConfig.OPENROUTER_X_TITLE;

      const url = new URL(`${OPENROUTER_BASE}/v1/${path}`);
      new URL(request.url).searchParams.forEach((v, k) => url.searchParams.set(k, v));

      const upstreamResponse = await fetch(url.toString(), {
        method: request.method,
        headers,
        body: body ? JSON.stringify(body) : request.method === "GET" ? null : await request.arrayBuffer(),
      });

      let upstreamJsonError: any = null;
      if (!upstreamResponse.ok) {
        try { upstreamJsonError = await upstreamResponse.clone().json(); } catch { upstreamJsonError = null; }
        writeSystemLog("warn", "Upstream returned non-2xx", {
          status: upstreamResponse.status, path, userId,
          upstreamMessage: upstreamJsonError?.error?.message || upstreamJsonError?.message || null,
        });
      }

      const responseHeaders = cleanResponseHeaders(upstreamResponse.headers);

      // ── Streaming response ─────────────────────────────────────────────────
      if (upstreamResponse.headers.get("content-type")?.includes("text/event-stream")) {
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of streamWithUsageTracking(upstreamResponse, userId, {
                onMissingUsage: async () => {
                  if (userId && usageReservation) {
                    writeSystemLog("warn", "Stream completed without usage payload; applying reserved estimate", {
                      userId,
                      path,
                      model: modelName,
                      estimated_tokens: usageReservation.usage.total_tokens,
                    });
                    await processUsage(userId, modelName, usageReservation.usage);
                  }
                },
              })) {
                controller.enqueue(chunk);
              }
              controller.close();
            } finally {
              await releaseUsageEstimate(usageReservation);
              usageReservation = null;
              logRequestPerformance({
                userId, model: modelName, path, method: request.method,
                status: upstreamResponse.status, isStream: true,
                startedAt: requestStartedAt, completedAt: new Date(), totalCost: 0,
                requestedModel: requestedModelName !== "unknown" ? requestedModelName : modelName,
                resolvedModel: modelName,
                routingReason: routingDecision?.reason || null,
              });
            }
          },
        });
        return new Response(stream, { status: upstreamResponse.status, headers: responseHeaders });
      }

      // ── JSON response ──────────────────────────────────────────────────────
      const respData = upstreamJsonError ?? await upstreamResponse.json();
      const completedAt = new Date();
      logRequestPerformance({
        userId, model: respData.model || modelName, path, method: request.method,
        status: upstreamResponse.status, isStream: false, startedAt: requestStartedAt, completedAt,
        totalCost: Number(respData?.usage?.cost || respData?.usage?.total_cost || 0),
        requestedModel: requestedModelName !== "unknown" ? requestedModelName : respData.model || modelName,
        resolvedModel: respData.model || modelName,
        routingReason: routingDecision?.reason || null,
      });

      if (!upstreamResponse.ok) {
        await releaseUsageEstimate(usageReservation);
        usageReservation = null;
        return new Response(JSON.stringify(classifyUpstreamError(upstreamResponse.status, respData)), {
          status: upstreamResponse.status,
          headers: responseHeaders,
        });
      }

      await releaseUsageEstimate(usageReservation);
      usageReservation = null;
      if (respData.usage) {
        await processUsage(userId, respData.model || modelName, respData.usage);
      } else if (userId) {
        const estimatedUsage = await estimateReservedUsage(respData.model || modelName, body);
        writeSystemLog("warn", "JSON response completed without usage payload; applying reserved estimate", {
          userId,
          path,
          model: respData.model || modelName,
          estimated_tokens: estimatedUsage.total_tokens,
        });
        await processUsage(userId, respData.model || modelName, estimatedUsage);
      }
      return new Response(JSON.stringify(respData), { status: upstreamResponse.status, headers: responseHeaders });
    } finally {
      if (usageReservation) {
        await releaseUsageEstimate(usageReservation);
        usageReservation = null;
      }
    }
  });
