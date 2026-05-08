/**
 * Toolstem MCP Proxy — AI-to-AI payment gateway.
 *
 * Architecture:
 *   Agent --(x402 payment header)--> Worker (this file)
 *      Worker verifies payment via x402 facilitator
 *      Worker forwards request to Apify MCP gateway using pooled token
 *      Worker returns Apify's response to agent
 *
 * Environments:
 *   - X402_NETWORK = eip155:84532 (Base Sepolia, testnet) for first-pass testing
 *   - X402_NETWORK = eip155:8453  (Base mainnet)         for production
 *
 * Secrets (set via `wrangler secret put` or GitHub Actions deploy):
 *   - APIFY_TOKEN   — pooled Apify API token (we pay Apify, agents pay us)
 *   - PAYTO_ADDRESS — our USDC receiving address on Base
 */

import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import {
  FINANCE_TOOLS,
  SEC_TOOLS,
  getToolsForRoute,
  getUpstreamWrapperName,
  validateToolArguments,
  type RouteKey,
  type ToolDef,
} from "./tool-defs";
import { playground, isAllowedPlaygroundOrigin } from "./playground";

type Bindings = {
  APIFY_TOKEN: string;
  PAYTO_ADDRESS: string;
  APIFY_GATEWAY: string;
  DEFAULT_ACTOR: string;
  SEC_ACTOR: string;
  X402_NETWORK: string;
  X402_FACILITATOR: string;
  // CDP facilitator credentials — required for Base mainnet (eip155:8453).
  // When absent we fall back to X402_FACILITATOR (public x402.org — Sepolia only).
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
};

/**
 * Build a facilitator client. Routes to CDP when CDP_API_KEY_ID is present
 * (required for mainnet), otherwise falls back to the public x402.org facilitator
 * (testnet only). Workers don't expose process.env so we pass keys explicitly.
 */
function buildFacilitatorClient(env: Bindings): HTTPFacilitatorClient {
  if (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
    const cdpConfig = createFacilitatorConfig(
      env.CDP_API_KEY_ID,
      env.CDP_API_KEY_SECRET,
    );
    return new HTTPFacilitatorClient(cdpConfig);
  }
  return new HTTPFacilitatorClient({ url: env.X402_FACILITATOR });
}

type Variables = {
  // Set by the /mcp/* middleware when a free discovery method bypasses
  // payment, so the downstream proxy can read the already-consumed body.
  mcpFreeBody?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ── Public/free endpoints ───────────────────────────────────────────────────

app.get("/", (c) =>
  c.json({
    service: "toolstem-proxy",
    description:
      "AI-to-AI MCP payment gateway. Agents pay per call via x402; no Apify account required.",
    endpoints: {
      "/mcp/finance": "Toolstem Financial Intelligence — stock data, financials, peers",
      "/mcp/sec": "Toolstem SEC EDGAR Signal Intelligence — filings, insiders, 8-K severity",
      "/playground": "Free walletless cached demo responses (AAPL/MSFT/GOOGL only)",
      "/health": "Liveness probe",
    },
    payment: {
      protocol: "x402",
      network: c.env.X402_NETWORK,
      asset: "USDC",
    },
    docs: "https://github.com/toolstem/toolstem-proxy",
  }),
);

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

// In-browser end-to-end test harness is served via Cloudflare Workers Assets
// binding (configured in wrangler.toml). The Worker auto-serves /test.html
// from public/. We add a redirect from /test → /test.html for convenience.
app.get("/test", (c) => c.redirect("/test.html", 302));

// /playground/* uses a stricter CORS allowlist (marketing origins + localhost
// + Claude Desktop). Apply before the wildcard CORS middleware below so
// these routes don't end up with Access-Control-Allow-Origin: *.
app.use("/playground/*", async (c, next) => {
  const origin = c.req.header("Origin") ?? null;
  const userAgent = c.req.header("User-Agent") ?? null;
  const { allow, allowOrigin } = isAllowedPlaygroundOrigin(origin, userAgent);

  if (c.req.method === "OPTIONS") {
    if (!allow) return new Response(null, { status: 403 });
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (allowOrigin) headers["Access-Control-Allow-Origin"] = allowOrigin;
    return new Response(null, { status: 204, headers });
  }

  await next();
  if (allowOrigin) {
    c.header("Access-Control-Allow-Origin", allowOrigin);
    c.header("Vary", "Origin");
  }
});
app.route("/playground", playground);

// CORS: required so the /test page can call /mcp/* from the same origin.
// (Same-origin in our case since /test is served from mcp.toolstem.com too,
// but we add headers anyway for any future cross-origin agent clients.)
app.use("*", async (c, next) => {
  await next();
  // Don't override the playground's own CORS headers.
  if (c.req.path.startsWith("/playground")) return;
  c.header("Access-Control-Allow-Origin", "*");
  c.header(
    "Access-Control-Expose-Headers",
    "payment-required, payment-response, x-payment-response, x-rejection-reason, mcp-session-id",
  );
  c.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Payment, Payment-Signature, mcp-session-id",
  );
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
});
app.options("*", (c) => new Response(null, { status: 204 }));

// ── x402-protected MCP endpoints ────────────────────────────────────────────

/**
 * Build the x402 middleware. We cache the constructed middleware per Worker
 * isolate so the facilitator handshake only runs on the cold-start request.
 *
 * Workers don't have a startup hook, but isolates persist across requests once
 * warmed, so module-level caching gives us effectively the same behavior.
 */
let cachedMiddleware: ReturnType<typeof paymentMiddleware> | null = null;

async function getPaymentMiddleware(env: Bindings) {
  if (cachedMiddleware) return cachedMiddleware;

  const network = env.X402_NETWORK as `${string}:${string}`;
  const facilitator = buildFacilitatorClient(env);
  // registerExtension(bazaarResourceServerExtension) wires the per-route
  // `extensions.bazaar` declarations (below) into the /verify call so the
  // facilitator catalogs us in the Bazaar discovery API. Without it, our
  // declared metadata is dropped and we never appear in
  // https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources.
  const resourceServer = new x402ResourceServer(facilitator)
    .register(network, new ExactEvmServerScheme())
    .registerExtension(bazaarResourceServerExtension);

  // Sync supported schemes/networks from the facilitator before serving traffic.
  // The middleware passes syncFacilitatorOnStart=true (default) but in Workers
  // we have to await it explicitly because there is no startup phase.
  await resourceServer.initialize();

  cachedMiddleware = paymentMiddleware(
    {
      "POST /mcp/finance": {
        accepts: {
          scheme: "exact",
          price: "$0.01",
          network,
          payTo: env.PAYTO_ADDRESS,
          maxTimeoutSeconds: 60,
        },
        description:
          "Toolstem Financial Intelligence MCP — stock quotes, fundamentals, peers, financial statements. One paid tool call.",
        // The CDP discovery API currently only ingests HTTP-typed Bazaar
        // entries (?type=mcp returns 0 across the entire catalog as of
        // 2026-05). The single MCP-server listing that does appear
        // (api.bitfence.ai/mcp) is declared HTTP body-style. We mirror that
        // shape: the JSON-RPC envelope is the body schema, and the catalog
        // gets a working example invocation.
        extensions: {
          bazaar: {
            name: "toolstem-finance",
            description:
              "Toolstem Financial Intelligence MCP server. Streamable HTTP transport. Provides stock quotes, fundamentals, peer comparisons, and financial statements via a single paid MCP endpoint.",
            category: "finance",
            discoverable: true,
            ...declareDiscoveryExtension({
              // method is filled in by enrichDeclaration at request time
              // (route is "POST /mcp/...") and is omitted from the
              // DeclareBodyDiscoveryExtensionConfig input type.
              bodyType: "json",
              input: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "get_quote", arguments: { symbol: "AAPL" } },
              },
              inputSchema: {
                properties: {
                  jsonrpc: {
                    type: "string",
                    description: "JSON-RPC protocol version, must be \"2.0\".",
                  },
                  id: {
                    type: "number",
                    description: "Client-chosen request id echoed in the response.",
                  },
                  method: {
                    type: "string",
                    description:
                      "MCP method — typically \"tools/call\", or \"initialize\"/\"tools/list\" for discovery.",
                  },
                  params: {
                    type: "object",
                    description:
                      "MCP method params. For tools/call: { name, arguments }.",
                  },
                },
                required: ["jsonrpc", "method", "id"],
              },
              output: {
                example: {
                  jsonrpc: "2.0",
                  id: 1,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: '{"symbol":"AAPL","price":228.52,"change":+1.34,"asOf":"2026-05-04"}',
                      },
                    ],
                  },
                },
              },
            }).bazaar,
          },
        },
      },
      "POST /mcp/sec": {
        accepts: {
          scheme: "exact",
          price: "$0.01",
          network,
          payTo: env.PAYTO_ADDRESS,
          maxTimeoutSeconds: 60,
        },
        description:
          "Toolstem SEC EDGAR Signal Intelligence MCP — filings, insider transactions, 8-K severity scoring. One paid tool call.",
        extensions: {
          bazaar: {
            name: "toolstem-sec",
            description:
              "Toolstem SEC EDGAR Signal Intelligence MCP server. Streamable HTTP transport. Surfaces filings, insider transactions, and 8-K severity scoring via a single paid MCP endpoint.",
            category: "finance",
            discoverable: true,
            ...declareDiscoveryExtension({
              // method is filled in by enrichDeclaration at request time
              // (route is "POST /mcp/...") and is omitted from the
              // DeclareBodyDiscoveryExtensionConfig input type.
              bodyType: "json",
              input: {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: "get_recent_filings",
                  arguments: { ticker: "AAPL", limit: 5 },
                },
              },
              inputSchema: {
                properties: {
                  jsonrpc: {
                    type: "string",
                    description: "JSON-RPC protocol version, must be \"2.0\".",
                  },
                  id: {
                    type: "number",
                    description: "Client-chosen request id echoed in the response.",
                  },
                  method: {
                    type: "string",
                    description:
                      "MCP method — typically \"tools/call\", or \"initialize\"/\"tools/list\" for discovery.",
                  },
                  params: {
                    type: "object",
                    description:
                      "MCP method params. For tools/call: { name, arguments }.",
                  },
                },
                required: ["jsonrpc", "method", "id"],
              },
              output: {
                example: {
                  jsonrpc: "2.0",
                  id: 1,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: '[{"form":"8-K","filedAt":"2026-05-01","severity":"low"}]',
                      },
                    ],
                  },
                },
              },
            }).bazaar,
          },
        },
      },
    },
    resourceServer,
    undefined,
    undefined,
    false, // don't sync again — we already initialized above
  );

  return cachedMiddleware;
}

// MCP discovery and notification methods are free — clients must be able to
// call `initialize` and `tools/list` without paying, otherwise no standard MCP
// client (Claude Desktop, mcp-adapters, etc.) can ever reach `tools/call`.
// Only the methods that actually invoke server-side work are charged.
//
// Free:  initialize, tools/list, prompts/list, resources/list, notifications/*
// Paid:  tools/call, prompts/get, resources/read
const FREE_MCP_METHODS = new Set([
  "initialize",
  "tools/list",
  "prompts/list",
  "resources/list",
]);

function isFreeMcpMethod(method: unknown): boolean {
  if (typeof method !== "string") return false;
  if (FREE_MCP_METHODS.has(method)) return true;
  if (method.startsWith("notifications/")) return true;
  return false;
}

// Apply the payment middleware to /mcp/* routes only.
app.use("/mcp/*", async (c, next) => {
  // Non-POST verbs (GET discovery hint, OPTIONS preflight) never carry a
  // JSON-RPC payload, so they're inherently free. Skip the paid middleware
  // entirely so the route handler (or CORS/notFound) can respond directly.
  if (c.req.method !== "POST") return next();

  // Inspect the JSON-RPC body BEFORE running the paid middleware. Discovery
  // methods skip payment entirely and proxy straight to the upstream MCP
  // server. We buffer the body once and stash it on the context so the
  // downstream proxy handler can re-read it without consuming the stream.
  try {
    const rawBody = await c.req.raw.clone().text();
    if (rawBody) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = undefined;
      }
      const method = (parsed as { method?: unknown } | undefined)?.method;
      if (isFreeMcpMethod(method)) {
        c.set("mcpFreeBody", rawBody);
        return next();
      }
    }
  } catch {
    // If we can't read the body, fall through to the paid path — the
    // middleware will reject it cleanly.
  }

  try {
    const mw = await getPaymentMiddleware(c.env);
    const result = await mw(c, next);
    // If the middleware rejected the payment with a 402, decode the
    // payment-required header and surface the inner `error` field so
    // we can see exactly why it rejected (e.g. "No matching payment requirements"
    // vs an invalidReason from the facilitator).
    if (result instanceof Response && result.status === 402) {
      const prHeader = result.headers.get("payment-required");
      if (prHeader) {
        try {
          const decoded = JSON.parse(atob(prHeader));
          // Echo the rejection reason as a custom header so the test page
          // can read it without parsing the base64 payload itself.
          const newHeaders = new Headers(result.headers);
          newHeaders.set(
            "x-rejection-reason",
            String((decoded as { error?: string }).error ?? "unknown"),
          );
          return new Response(result.body, {
            status: result.status,
            headers: newHeaders,
          });
        } catch {
          /* fall through */
        }
      }
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[x402-mw error]", message, stack);
    return c.json(
      {
        error: "x402_middleware_error",
        message,
        // Helpful for debugging during bring-up; remove before production traffic.
        debug_stack: stack?.split("\n").slice(0, 6),
      },
      500,
    );
  }
});

// ── Tool re-mapper ──────────────────────────────────────────────────────────
//
// The upstream Apify MCP gateway exposes each Toolstem actor as a SINGLE tool
// (e.g. `toolstem--toolstem-mcp-server`) with the inner tool selection hidden
// behind a `tool` enum parameter. That contradicts our public docs, README,
// and HN announcement, which describe a 3-tool / 5-tool surface. The
// re-mapper makes the on-the-wire surface match the marketing:
//
//   * `tools/list` responses are intercepted: the wrapper entry is replaced
//     with the synthesized 3 (Finance) / 5 (SEC) tool definitions, and
//     Apify's internal `get-actor-output` tool is dropped.
//   * `tools/call` requests are translated before forwarding upstream:
//       inbound  { name: "get_stock_snapshot", arguments: { symbol: "AAPL" } }
//       upstream { name: "toolstem--toolstem-mcp-server",
//                  arguments: { tool: "get_stock_snapshot", symbol: "AAPL" } }
//     Inbound arguments are validated against the synthesized inputSchema
//     before the upstream call so we get per-tool validation that the
//     wrapper does not provide.
//
// Wallet, pricing, and the x402 payment flow are unchanged. The translation
// only kicks in on /mcp/finance and /mcp/sec, and only for tools/list and
// tools/call (every other JSON-RPC method passes through untouched).

const FINANCE_TOOL_NAMES = new Set(FINANCE_TOOLS.map((t) => t.name));
const SEC_TOOL_NAMES = new Set(SEC_TOOLS.map((t) => t.name));

function routeForPath(path: string): RouteKey | null {
  if (path === "/mcp/finance") return "finance";
  if (path === "/mcp/sec") return "sec";
  return null;
}

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown> | undefined;
};

function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): Response {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  };
  if (data !== undefined) {
    (body.error as Record<string, unknown>).data = data;
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Rewrite the inbound JSON-RPC body for a `tools/call` so that the upstream
 * Apify wrapper receives the wrapped form. Returns either the rewritten
 * body string OR a Response to short-circuit (validation failure / unknown
 * tool / malformed params).
 */
function translateToolsCall(
  parsed: JsonRpcRequest,
  route: RouteKey,
): { body: string } | { response: Response } {
  const params = parsed.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {
      response: jsonRpcError(parsed.id, -32602, "Invalid params: expected object"),
    };
  }
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string") {
    return {
      response: jsonRpcError(parsed.id, -32602, "Invalid params: name must be a string"),
    };
  }
  const validNames = route === "finance" ? FINANCE_TOOL_NAMES : SEC_TOOL_NAMES;
  if (!validNames.has(name)) {
    return {
      response: jsonRpcError(
        parsed.id,
        -32601,
        `Unknown tool: ${name}`,
        {
          available: Array.from(validNames),
        },
      ),
    };
  }
  const toolDef = getToolsForRoute(route).find((t) => t.name === name) as ToolDef;
  const rawArgs = (params as { arguments?: unknown }).arguments ?? {};
  const validationError = validateToolArguments(toolDef, rawArgs);
  if (validationError) {
    return {
      response: jsonRpcError(
        parsed.id,
        -32602,
        `Invalid arguments for ${name}: ${validationError}`,
      ),
    };
  }
  const wrapperName = getUpstreamWrapperName(route);
  const inboundArgs = rawArgs as Record<string, unknown>;
  const upstreamArgs: Record<string, unknown> = {
    tool: name,
    ...inboundArgs,
  };
  const rewritten = {
    ...parsed,
    params: {
      ...params,
      name: wrapperName,
      arguments: upstreamArgs,
    },
  };
  return { body: JSON.stringify(rewritten) };
}

/**
 * SSE frames are `event: <name>\n` followed by one or more `data: <line>\n`
 * lines and an empty line terminator. We only need to rewrite the `data:`
 * payload of frames that contain a JSON-RPC `tools/list` result; everything
 * else is passed through verbatim.
 */
function rewriteToolsListInBody(
  bodyText: string,
  route: RouteKey,
): string {
  const trimmed = bodyText.trimStart();
  if (trimmed.startsWith("{")) {
    // Plain JSON response (server collapsed the SSE envelope).
    try {
      const parsed = JSON.parse(bodyText);
      const out = rewriteToolsListJson(parsed, route);
      return out !== null ? JSON.stringify(out) : bodyText;
    } catch {
      return bodyText;
    }
  }
  // Otherwise treat as SSE — split on blank-line frame terminators while
  // preserving newlines inside data lines. We re-emit each frame; only frames
  // whose data parses as a tools/list JSON-RPC response get rewritten.
  const frames = bodyText.split(/\r?\n\r?\n/);
  const out: string[] = [];
  for (const frame of frames) {
    if (!frame.trim()) {
      out.push(frame);
      continue;
    }
    const lines = frame.split(/\r?\n/);
    const dataLines: string[] = [];
    const otherLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      } else {
        otherLines.push(line);
      }
    }
    if (dataLines.length === 0) {
      out.push(frame);
      continue;
    }
    const joined = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(joined);
    } catch {
      out.push(frame);
      continue;
    }
    const rewritten = rewriteToolsListJson(parsed, route);
    if (rewritten === null) {
      out.push(frame);
      continue;
    }
    const newData = JSON.stringify(rewritten);
    const rebuilt = [...otherLines, ...newData.split("\n").map((l) => `data: ${l}`)]
      .join("\n");
    out.push(rebuilt);
  }
  return out.join("\n\n");
}

/**
 * If `parsed` looks like a tools/list JSON-RPC response, return a new value
 * with the synthesized tools array. Otherwise return null (caller leaves the
 * frame alone).
 */
function rewriteToolsListJson(parsed: unknown, route: RouteKey): unknown | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const result = obj.result;
  if (!result || typeof result !== "object") return null;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return null;
  const synthesized = getToolsForRoute(route).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
  return {
    ...obj,
    result: {
      ...(result as Record<string, unknown>),
      tools: synthesized,
    },
  };
}

// ── Apify MCP gateway proxy ─────────────────────────────────────────────────

async function proxyToApify(
  request: Request,
  env: Bindings,
  actor: string,
  prebufferedBody?: string,
): Promise<Response> {
  // Apify gateway expects: https://mcp.apify.com/?tools=<actor>
  // with Bearer auth.
  const upstream = new URL(env.APIFY_GATEWAY);
  upstream.searchParams.set("tools", actor);

  // The free-discovery middleware reads the body to peek at the JSON-RPC
  // method, which consumes the stream. When that happens it stashes the
  // bytes for us to reuse here.
  const body = prebufferedBody ?? (await request.text());

  // MCP Streamable HTTP requires the client to advertise both content types.
  const acceptHeader =
    request.headers.get("accept") ?? "application/json, text/event-stream";

  const upstreamReq = new Request(upstream.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: acceptHeader,
      Authorization: `Bearer ${env.APIFY_TOKEN}`,
      // Forward MCP session header if present; Apify uses these for stateful sessions.
      ...(request.headers.get("mcp-session-id")
        ? { "mcp-session-id": request.headers.get("mcp-session-id")! }
        : {}),
    },
    body,
  });

  const upstreamRes = await fetch(upstreamReq);

  // Pass through status, headers (with sanitization), and body.
  const passthroughHeaders = new Headers();
  upstreamRes.headers.forEach((v, k) => {
    // Avoid leaking Apify-specific or sensitive headers.
    if (
      !k.toLowerCase().startsWith("apify-") &&
      k.toLowerCase() !== "set-cookie"
    ) {
      passthroughHeaders.set(k, v);
    }
  });

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: passthroughHeaders,
  });
}

/**
 * Wrapper that performs request/response translation around proxyToApify.
 * On the request side: detect tools/call, validate, and rewrite the body.
 * On the response side: detect tools/list and replace the wrapper tool entry
 * with the synthesized tool definitions. Streaming SSE responses are
 * buffered and rewritten — buffering is fine here because tools/list
 * responses are small.
 */
async function proxyWithRemap(
  request: Request,
  env: Bindings,
  route: RouteKey,
  actor: string,
  prebufferedBody?: string,
): Promise<Response> {
  // Read the body once. For free methods the discovery middleware already
  // consumed the stream into prebufferedBody; for paid methods we must read
  // here (the x402 middleware preserves the body).
  const inboundBody = prebufferedBody ?? (await request.text());

  let parsed: JsonRpcRequest | undefined;
  try {
    parsed = inboundBody ? (JSON.parse(inboundBody) as JsonRpcRequest) : undefined;
  } catch {
    parsed = undefined;
  }

  let upstreamBody = inboundBody;
  const method = parsed?.method;
  const isToolsCall = method === "tools/call";
  const isToolsList = method === "tools/list";
  const isPromptsList = method === "prompts/list";

  // Short-circuit prompts/list: Toolstem exposes no prompts.  The upstream
  // Apify wrapper leaks a generic "GetLatestNewsOnTopic" prompt that has
  // nothing to do with our tools.  Return an empty array without calling
  // upstream — keeps the surface honest and avoids confusing MCP clients.
  if (isPromptsList && parsed) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id ?? null,
        result: { prompts: [] },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (isToolsCall && parsed) {
    const out = translateToolsCall(parsed, route);
    if ("response" in out) return out.response;
    upstreamBody = out.body;
  }

  const upstreamRes = await proxyToApify(request, env, actor, upstreamBody);

  if (!isToolsList) return upstreamRes;
  if (upstreamRes.status !== 200) return upstreamRes;

  // Buffer & rewrite. Preserve all headers so MCP session continuity works.
  const text = await upstreamRes.text();
  const rewritten = rewriteToolsListInBody(text, route);
  const newHeaders = new Headers(upstreamRes.headers);
  newHeaders.delete("content-length");
  return new Response(rewritten, {
    status: upstreamRes.status,
    headers: newHeaders,
  });
}

app.post("/mcp/finance", async (c) =>
  proxyWithRemap(c.req.raw, c.env, "finance", c.env.DEFAULT_ACTOR, c.get("mcpFreeBody")),
);

app.post("/mcp/sec", async (c) =>
  proxyWithRemap(c.req.raw, c.env, "sec", c.env.SEC_ACTOR, c.get("mcpFreeBody")),
);

// GET on the MCP routes returns a small discovery hint instead of a 404.
// Useful for humans / agents that probe the URL with a browser to figure out
// what the endpoint expects. Streamable HTTP MCP is POST-only, so this is
// purely informational.
function buildDiscoveryHint(name: string, slug: string, route: RouteKey) {
  return {
    server: name,
    protocol: "mcp",
    version: "2024-11-05",
    transport: "streamable-http",
    payment: "x402",
    price_per_call: "0.01 USDC on Base",
    docs: `https://toolstem.com/${slug}/`,
    initialize: "POST with JSON-RPC 2.0 method=initialize",
    free_methods: [
      "initialize",
      "tools/list",
      "prompts/list",
      "resources/list",
      "notifications/*",
    ],
    paid_methods: ["tools/call", "prompts/get", "resources/read"],
    tools: getToolsForRoute(route).map((t) => t.name),
  };
}

app.get("/mcp/finance", (c) =>
  c.json(buildDiscoveryHint("toolstem-finance", "finance", "finance")),
);

app.get("/mcp/sec", (c) =>
  c.json(buildDiscoveryHint("toolstem-sec", "sec", "sec")),
);

// ── 404 ─────────────────────────────────────────────────────────────────────

app.notFound((c) =>
  c.json(
    {
      error: "not_found",
      hint: "See / for available endpoints.",
    },
    404,
  ),
);

export default app;
