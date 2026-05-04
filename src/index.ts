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
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { privateKeyToAccount } from "viem/accounts";

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
  // Test-only: private key for a self-custody buyer wallet used by /test-pay.
  // NEVER reused for anything else; funded with a few USDC for end-to-end smoke tests.
  TEST_BUYER_PRIVATE_KEY?: string;
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

const app = new Hono<{ Bindings: Bindings }>();

// ── Public/free endpoints ───────────────────────────────────────────────────

app.get("/", (c) =>
  c.json({
    service: "toolstem-proxy",
    description:
      "AI-to-AI MCP payment gateway. Agents pay per call via x402; no Apify account required.",
    endpoints: {
      "/mcp/finance": "Toolstem Financial Intelligence — stock data, financials, peers",
      "/mcp/sec": "Toolstem SEC EDGAR Signal Intelligence — filings, insiders, 8-K severity",
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

// CORS: required so the /test page can call /mcp/* from the same origin.
// (Same-origin in our case since /test is served from mcp.toolstem.com too,
// but we add headers anyway for any future cross-origin agent clients.)
app.use("*", async (c, next) => {
  await next();
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

// ── DIAGNOSTIC: bypasses paymentMiddleware so we can see the actual rejection reason ──
// We hold a separate handle to the resourceServer so we can call verifyPayment directly.
let cachedResourceServer: x402ResourceServer | null = null;
async function getResourceServer(env: Bindings): Promise<x402ResourceServer> {
  if (cachedResourceServer) return cachedResourceServer;
  const network = env.X402_NETWORK as `${string}:${string}`;
  const facilitator = buildFacilitatorClient(env);
  // registerExtension(bazaarResourceServerExtension) — without this the
  // resource server will not surface the bazaar discovery extension to the
  // facilitator on /verify, so cataloging never happens.
  const rs = new x402ResourceServer(facilitator)
    .register(network, new ExactEvmServerScheme())
    .registerExtension(bazaarResourceServerExtension);
  await rs.initialize();
  cachedResourceServer = rs;
  return rs;
}

app.post("/mcp/debug", async (c) => {
  const out: Record<string, unknown> = {};
  const header = c.req.header("Payment-Signature") || c.req.header("payment-signature") || c.req.header("X-Payment");
  out.header_present = !!header;
  out.header_length = header?.length ?? 0;
  out.header_preview = header ? header.slice(0, 80) + "…" : null;
  out.network = c.env.X402_NETWORK;
  out.payTo = c.env.PAYTO_ADDRESS;

  if (!header) {
    return c.json({ ...out, error: "no_payment_header" }, 400);
  }

  // Step 1: decode
  let payload: unknown;
  try {
    payload = decodePaymentSignatureHeader(header);
    out.decoded = payload;
  } catch (err) {
    out.decode_error = err instanceof Error ? err.message : String(err);
    return c.json({ ...out, error: "decode_failed" }, 400);
  }

  // Step 2: build PaymentRequirements the SAME way the real middleware does.
  const network = c.env.X402_NETWORK as `${string}:${string}`;
  try {
    const rs = await getResourceServer(c.env);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const built = await (rs as any).buildPaymentRequirements({
      scheme: "exact",
      price: "$0.01",
      network,
      payTo: c.env.PAYTO_ADDRESS,
      maxTimeoutSeconds: 60,
    });
    const requirements = Array.isArray(built) ? built[0] : built;
    out.requirements_used = requirements;

    // Step 2b: deep diff vs what the client signed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accepted = (payload as any)?.accepted;
    out.client_accepted = accepted;
    if (accepted) {
      const reqJson = JSON.stringify(
        requirements,
        Object.keys(requirements as Record<string, unknown>).sort(),
      );
      const accJson = JSON.stringify(
        accepted,
        Object.keys(accepted).sort(),
      );
      out.deep_equal_match = reqJson === accJson;
      out.req_keys = Object.keys(requirements as Record<string, unknown>).sort();
      out.acc_keys = Object.keys(accepted).sort();
      // Field-by-field diff (top level + extra)
      const fieldDiff: Record<string, { req: unknown; acc: unknown }> = {};
      const allKeys = new Set([
        ...Object.keys(requirements as Record<string, unknown>),
        ...Object.keys(accepted),
      ]);
      for (const k of allKeys) {
        const r = (requirements as Record<string, unknown>)[k];
        const a = (accepted as Record<string, unknown>)[k];
        if (JSON.stringify(r) !== JSON.stringify(a)) {
          fieldDiff[k] = { req: r, acc: a };
        }
      }
      out.field_diff = fieldDiff;
    }

    // Step 3: try findMatchingRequirements as the real middleware does it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = (rs as any).findMatchingRequirements(
      [requirements],
      payload,
    );
    out.match_found = !!match;

    // Step 4: call the actual verifier
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const verifyResult = await rs.verifyPayment(payload as any, requirements as any);
      out.verify_result = verifyResult;
    } catch (err) {
      out.verify_throw = err instanceof Error ? err.message : String(err);
    }

    // Step 4b: call CDP /verify directly (bypass @x402/core truncation) so
    // we can see the FULL error message CDP returns. This call duplicates what
    // verifyPayment does internally but lets us read the raw response.
    if (c.env.CDP_API_KEY_ID && c.env.CDP_API_KEY_SECRET) {
      try {
        const { createFacilitatorConfig: mkCfg } = await import("@coinbase/x402");
        const cfg = mkCfg(c.env.CDP_API_KEY_ID, c.env.CDP_API_KEY_SECRET);
        const headersFactory = (cfg as { createAuthHeaders?: () => Promise<{ verify: Record<string,string> }> }).createAuthHeaders;
        const allHeaders = headersFactory ? await headersFactory() : { verify: {} };
        const verifyHeaders = { ...allHeaders.verify, "Content-Type": "application/json" };
        const cdpRaw = await fetch(`${cfg.url}/verify`, {
          method: "POST",
          headers: verifyHeaders,
          body: JSON.stringify({
            paymentPayload: payload,
            paymentRequirements: requirements,
          }),
        });
        const cdpText = await cdpRaw.text();
        out.cdp_status = cdpRaw.status;
        out.cdp_raw_body = cdpText;
      } catch (err) {
        out.cdp_probe_error = err instanceof Error ? err.message : String(err);
      }
    }

    return c.json(out, 200);
  } catch (err) {
    out.verify_error = err instanceof Error ? err.message : String(err);
    out.verify_stack = err instanceof Error ? err.stack?.split("\n").slice(0, 8) : undefined;
    return c.json(out, 500);
  }
});

// ── /test-pay: server-side end-to-end paid call ─────────────────────
//
// Uses a Cloudflare-secret test buyer private key to drive a real x402 paid
// request against /mcp/finance. Library handles V1 vs V2 payload negotiation
// and produces the correct shape (EIP-3009 for USDC). Returns the captured
// settlement TX hash so we can verify mainnet flow end-to-end without a browser
// wallet, and without hand-rolling EIP-712 signing.
//
// Security: TEST_BUYER_PRIVATE_KEY is a one-purpose, low-balance wallet used
// only for this endpoint. It is never reused. The private key is set via
// `wrangler secret put` and never appears in logs or responses.

let cachedTestPayClient: x402HTTPClient | null = null;

function buildTestPayClient(env: Bindings): x402HTTPClient {
  if (cachedTestPayClient) return cachedTestPayClient;
  if (!env.TEST_BUYER_PRIVATE_KEY) {
    throw new Error("TEST_BUYER_PRIVATE_KEY not set");
  }
  // viem expects 0x-prefixed hex. Tolerate either form on input.
  const raw = env.TEST_BUYER_PRIVATE_KEY.trim();
  const pk = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  const signer = privateKeyToAccount(pk);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  cachedTestPayClient = new x402HTTPClient(client);
  return cachedTestPayClient;
}

app.post("/test-pay", async (c) => {
  const out: Record<string, unknown> = {
    network: c.env.X402_NETWORK,
    payTo: c.env.PAYTO_ADDRESS,
    started: new Date().toISOString(),
  };

  if (!c.env.TEST_BUYER_PRIVATE_KEY) {
    return c.json({ ...out, error: "TEST_BUYER_PRIVATE_KEY_not_set" }, 500);
  }

  let httpClient: x402HTTPClient;
  let buyerAddress: string;
  try {
    httpClient = buildTestPayClient(c.env);
    const raw = c.env.TEST_BUYER_PRIVATE_KEY.trim();
    const pk = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
    buyerAddress = privateKeyToAccount(pk).address;
    out.buyer_address = buyerAddress;
  } catch (err) {
    out.client_init_error = err instanceof Error ? err.message : String(err);
    return c.json(out, 500);
  }

  // Self-call our own protected endpoint. Cloudflare blocks Workers from
  // fetching their own public hostname (522 origin loop), so we invoke the
  // Hono app's fetch handler directly with a fabricated Request. This stays
  // entirely inside the same isolate — no network round trip — which is
  // also faster and cheaper.
  const target = new URL(c.req.url);
  target.pathname = "/mcp/finance";
  target.search = "";

  const selfFetch = async (req: Request): Promise<Response> =>
    Promise.resolve(app.fetch(req, c.env, c.executionCtx));

  // Minimal MCP initialize body so /mcp/finance has something to forward.
  // We only need the 402 + retry handshake to settle a real on-chain payment;
  // the response body is incidental.
  const mcpInitBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "toolstem-test-pay", version: "1.0.0" },
    },
  });

  // 1. Initial unpaid request — expect 402.
  let firstResp: Response;
  try {
    firstResp = await selfFetch(
      new Request(target.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: mcpInitBody,
      }),
    );
  } catch (err) {
    out.first_fetch_error = err instanceof Error ? err.message : String(err);
    return c.json(out, 502);
  }
  out.first_status = firstResp.status;
  if (firstResp.status !== 402) {
    out.first_body = await firstResp.text();
    out.error = "expected_402_on_first_call";
    return c.json(out, 500);
  }

  // 2. Parse 402 → PaymentRequired.
  let paymentRequired;
  try {
    const firstBody = await firstResp.json().catch(() => undefined);
    paymentRequired = httpClient.getPaymentRequiredResponse(
      (name: string) => firstResp.headers.get(name),
      firstBody,
    );
    out.payment_required = paymentRequired;
  } catch (err) {
    out.parse_pr_error = err instanceof Error ? err.message : String(err);
    return c.json(out, 500);
  }

  // 3. Sign payment payload (library picks EIP-3009 for USDC, V2 wrap).
  let signedHeaders: Record<string, string>;
  try {
    const payload = await httpClient.createPaymentPayload(paymentRequired);
    out.signed_payload_preview = {
      x402Version: (payload as { x402Version?: number })?.x402Version,
      scheme: (payload as { scheme?: string })?.scheme,
      network: (payload as { network?: string })?.network,
      // Don't dump full signature in response; just confirm shape.
      payload_keys: Object.keys((payload as { payload?: object })?.payload ?? {}),
    };
    signedHeaders = httpClient.encodePaymentSignatureHeader(payload);
  } catch (err) {
    out.sign_error = err instanceof Error ? err.message : String(err);
    out.sign_stack = err instanceof Error ? err.stack?.split("\n").slice(0, 8) : undefined;
    return c.json(out, 500);
  }

  // 4. Retry with payment header.
  let secondResp: Response;
  try {
    secondResp = await selfFetch(
      new Request(target.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...signedHeaders,
        },
        body: mcpInitBody,
      }),
    );
  } catch (err) {
    out.second_fetch_error = err instanceof Error ? err.message : String(err);
    return c.json(out, 502);
  }
  out.second_status = secondResp.status;
  out.rejection_reason = secondResp.headers.get("x-rejection-reason");

  // 5. Capture settlement (payment-response or x-payment-response header).
  try {
    const settle = httpClient.getPaymentSettleResponse((name: string) =>
      secondResp.headers.get(name),
    );
    out.settle = settle;
  } catch (err) {
    out.settle_decode_error = err instanceof Error ? err.message : String(err);
  }

  const bodyText = await secondResp.text();
  out.second_body_preview = bodyText.slice(0, 500);
  out.completed = new Date().toISOString();

  return c.json(out, secondResp.status === 200 ? 200 : 500);
});

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
        // declareDiscoveryExtension serializes the input/output contract the
        // Bazaar uses to render listings + drive discovery searches. The MCP
        // variant uses `toolName`; one entry per route is what the discovery
        // API surfaces today.
        extensions: {
          ...declareDiscoveryExtension({
            toolName: "toolstem-finance",
            description:
              "Toolstem Financial Intelligence MCP server. Streamable HTTP transport. Provides stock quotes, fundamentals, peer comparisons, and financial statements via a single paid MCP endpoint.",
            transport: "streamable-http",
            inputSchema: {
              type: "object",
              properties: {
                jsonrpc: { type: "string", const: "2.0" },
                method: {
                  type: "string",
                  description: "MCP method (initialize, tools/list, tools/call, …)",
                },
                params: { type: "object" },
                id: { type: ["string", "number"] },
              },
              required: ["jsonrpc", "method"],
            },
            example: {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "get_quote", arguments: { symbol: "AAPL" } },
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
          }),
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
          ...declareDiscoveryExtension({
            toolName: "toolstem-sec",
            description:
              "Toolstem SEC EDGAR Signal Intelligence MCP server. Streamable HTTP transport. Surfaces filings, insider transactions, and 8-K severity scoring via a single paid MCP endpoint.",
            transport: "streamable-http",
            inputSchema: {
              type: "object",
              properties: {
                jsonrpc: { type: "string", const: "2.0" },
                method: {
                  type: "string",
                  description: "MCP method (initialize, tools/list, tools/call, …)",
                },
                params: { type: "object" },
                id: { type: ["string", "number"] },
              },
              required: ["jsonrpc", "method"],
            },
            example: {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "get_recent_filings",
                arguments: { ticker: "AAPL", limit: 5 },
              },
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
          }),
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

// Apply the payment middleware to /mcp/* routes only.
// Skip /mcp/debug — that route does its own verification and returns full diagnostics.
app.use("/mcp/*", async (c, next) => {
  if (c.req.path === "/mcp/debug") return next();
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

// ── Apify MCP gateway proxy ─────────────────────────────────────────────────

async function proxyToApify(
  request: Request,
  env: Bindings,
  actor: string,
): Promise<Response> {
  // Apify gateway expects: https://mcp.apify.com/?tools=<actor>
  // with Bearer auth.
  const upstream = new URL(env.APIFY_GATEWAY);
  upstream.searchParams.set("tools", actor);

  const body = await request.text();

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

app.post("/mcp/finance", async (c) =>
  proxyToApify(c.req.raw, c.env, c.env.DEFAULT_ACTOR),
);

app.post("/mcp/sec", async (c) =>
  proxyToApify(c.req.raw, c.env, c.env.SEC_ACTOR),
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
