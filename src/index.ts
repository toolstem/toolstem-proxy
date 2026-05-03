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
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";

type Bindings = {
  APIFY_TOKEN: string;
  PAYTO_ADDRESS: string;
  APIFY_GATEWAY: string;
  DEFAULT_ACTOR: string;
  SEC_ACTOR: string;
  X402_NETWORK: string;
  X402_FACILITATOR: string;
};

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
    "payment-required, x-payment-response",
  );
  c.header(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Payment, mcp-session-id",
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
  const facilitator = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR });
  const rs = new x402ResourceServer(facilitator).register(
    network,
    new ExactEvmScheme(),
  );
  await rs.initialize();
  cachedResourceServer = rs;
  return rs;
}

app.post("/mcp/debug", async (c) => {
  const out: Record<string, unknown> = {};
  const header = c.req.header("X-Payment") || c.req.header("payment-signature");
  out.header_present = !!header;
  out.header_length = header?.length ?? 0;
  out.header_preview = header ? header.slice(0, 80) + "…" : null;
  out.network = c.env.X402_NETWORK;
  out.payTo = c.env.PAYTO_ADDRESS;

  if (!header) {
    return c.json({ ...out, error: "no_payment_header" }, 400);
  }

  // Step 1: try to decode the Base64 JSON
  let payload: unknown;
  try {
    payload = decodePaymentSignatureHeader(header);
    out.decoded = payload;
  } catch (err) {
    out.decode_error = err instanceof Error ? err.message : String(err);
    return c.json({ ...out, error: "decode_failed" }, 400);
  }

  // Step 2: build the PaymentRequirements that match what the middleware sends
  const network = c.env.X402_NETWORK as `${string}:${string}`;
  const requirements = {
    scheme: "exact" as const,
    network,
    maxAmountRequired: "10000", // $0.01 USDC = 10000 (6 decimals)
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
    payTo: c.env.PAYTO_ADDRESS,
    resource: "https://mcp.toolstem.com/mcp/finance",
    description: "Toolstem Financial Intelligence MCP — one tool call",
    mimeType: "",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };
  out.requirements_used = requirements;

  // Step 3: call the actual verifier and surface whatever it says
  try {
    const rs = await getResourceServer(c.env);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verifyResult = await rs.verifyPayment(payload as any, requirements as any);
    out.verify_result = verifyResult;
    return c.json(out, 200);
  } catch (err) {
    out.verify_error = err instanceof Error ? err.message : String(err);
    out.verify_stack = err instanceof Error ? err.stack?.split("\n").slice(0, 8) : undefined;
    return c.json(out, 500);
  }
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
  const facilitator = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR });
  const resourceServer = new x402ResourceServer(facilitator).register(
    network,
    new ExactEvmScheme(),
  );

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
        description: "Toolstem Financial Intelligence MCP — one tool call",
      },
      "POST /mcp/sec": {
        accepts: {
          scheme: "exact",
          price: "$0.01",
          network,
          payTo: env.PAYTO_ADDRESS,
          maxTimeoutSeconds: 60,
        },
        description: "Toolstem SEC EDGAR Signal Intelligence MCP — one tool call",
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
    return await mw(c, next);
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

  const upstreamReq = new Request(upstream.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
