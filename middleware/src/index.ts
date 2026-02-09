import { Elysia } from "elysia";

const OPENROUTER_BASE = "https://openrouter.ai/api";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_HTTP_REFERER = process.env.OPENROUTER_HTTP_REFERER;
const OPENROUTER_X_TITLE = process.env.OPENROUTER_X_TITLE;
const LOG_MODE = process.env.LOG_MODE || "metadata"; // metadata|off

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRIP_HEADERS = new Set([
  "cookie",
  "authorization",
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-proto",
  "x-forwarded-host",
  "accept-encoding",
  "host",
  "content-length",
]);

function cleanHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (!STRIP_HEADERS.has(lowerKey) && !HOP_BY_HOP_HEADERS.has(lowerKey)) {
      result[key] = value;
    }
  });
  return result;
}

function getUserFromJWT(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1];
    // Pad base64
    payload += "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(decoded);
    return data.email || data.id || data.sub || null;
  } catch {
    return null;
  }
}

function logEvent(event: Record<string, unknown>) {
  if (LOG_MODE === "off") return;
  console.log(JSON.stringify(event));
}

async function processUsage(
  userId: string | null,
  model: string,
  usage: Record<string, unknown>
) {
  logEvent({
    type: "usage_report",
    user_id: userId,
    model,
    usage,
  });
}

function cleanResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(lowerKey) &&
      lowerKey !== "content-length" &&
      lowerKey !== "content-encoding"
    ) {
      result[key] = value;
    }
  });
  return result;
}

async function* streamWithUsageTracking(
  response: Response,
  userId: string | null
): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      yield value;

      // Sniff for usage data
      try {
        const text = decoder.decode(value, { stream: true });
        buffer += text;

        while (buffer.includes("\n\n")) {
          const idx = buffer.indexOf("\n\n");
          const part = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          if (part.startsWith("data: ")) {
            const dataStr = part.slice(6).trim();
            if (dataStr && dataStr !== "[DONE]") {
              try {
                const data = JSON.parse(dataStr);
                if (data.usage) {
                  await processUsage(userId, data.model || "", data.usage);
                }
              } catch {
                // ignore parse errors
              }
            }
          }
        }
      } catch {
        // ignore sniffing errors
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const app = new Elysia()
  .all("/v1/*", async ({ request, params }) => {
    if (!OPENROUTER_API_KEY) {
      return new Response("OPENROUTER_API_KEY not set", { status: 500 });
    }

    const path = (params as { "*": string })["*"];
    const upstreamUrl = `${OPENROUTER_BASE}/v1/${path}`;

    // Get user ID from headers or JWT
    let userId =
      request.headers.get("x-openwebui-user-email") ||
      request.headers.get("x-openwebui-user-id");

    if (!userId) {
      const authHeader = request.headers.get("authorization") || "";
      if (authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        userId = getUserFromJWT(token);
      }
    }

    // Clean and prepare headers
    const headers = cleanHeaders(request.headers);
    headers["Authorization"] = `Bearer ${OPENROUTER_API_KEY}`;
    headers["User-Agent"] =
      request.headers.get("user-agent") || "OpenWebUI-Middleware/1.0";
    headers["Accept"] = "application/json";

    if (OPENROUTER_HTTP_REFERER) {
      headers["HTTP-Referer"] = OPENROUTER_HTTP_REFERER;
    }
    if (OPENROUTER_X_TITLE) {
      headers["X-Title"] = OPENROUTER_X_TITLE;
    }

    // Get request body and inject user tracking
    let body: BodyInit | null = null;
    let injected = false;

    if (request.method === "POST") {
      const contentType = request.headers.get("content-type") || "";
      if (contentType.toLowerCase().includes("application/json")) {
        try {
          const payload = await request.json();
          if (userId && typeof payload === "object" && payload !== null) {
            (payload as Record<string, unknown>).user = userId;
            injected = true;
          }
          body = JSON.stringify(payload);
          headers["Content-Type"] = "application/json";
        } catch {
          body = await request.text();
        }
      } else {
        body = await request.arrayBuffer();
      }
    }

    const start = Date.now();
    logEvent({
      type: "request",
      ts: Math.floor(start / 1000),
      method: request.method,
      path: `/v1/${path}`,
      query: new URL(request.url).search,
      user_id: userId,
      injected_tracking: injected,
    });

    // Build upstream URL with query params
    const url = new URL(upstreamUrl);
    const requestUrl = new URL(request.url);
    requestUrl.searchParams.forEach((value, key) => {
      url.searchParams.set(key, value);
    });

    const upstreamResponse = await fetch(url.toString(), {
      method: request.method,
      headers,
      body,
    });

    logEvent({
      type: "response_stream",
      status_code: upstreamResponse.status,
      elapsed_ms: Date.now() - start,
      path: `/v1/${path}`,
    });

    const responseHeaders = cleanResponseHeaders(upstreamResponse.headers);

    // Stream response with usage tracking
    const stream = new ReadableStream({
      async start(controller) {
        for await (const chunk of streamWithUsageTracking(
          upstreamResponse,
          userId
        )) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  })
  .listen(8080);

console.log(
  `🦊 OpenRouter Middleware (Elysia) running at http://localhost:${app.server?.port}`
);
