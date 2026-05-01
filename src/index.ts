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

// ── x402-protected MCP endpoints ────────────────────────────────────────────

/**
 * Build the x402 middleware lazily so it can read env vars per-request.
 * Cloudflare Workers don't have a startup phase like Node, so we attach the
 * middleware inside the request handler.
 */
function buildPaymentMiddleware(env: Bindings) {
  const network = env.X402_NETWORK as `${string}:${string}`;
  const facilitator = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR });
  const resourceServer = new x402ResourceServer(facilitator).register(
    network,
    new ExactEvmScheme(),
  );

  return paymentMiddleware(
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
    false, // don't sync facilitator on start (no startup in Workers)
  );
}

// Apply the payment middleware to /mcp/* routes only.
app.use("/mcp/*", async (c, next) => {
  const mw = buildPaymentMiddleware(c.env);
  return mw(c, next);
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
