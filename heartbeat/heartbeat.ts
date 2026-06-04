/**
 * Toolstem mainnet x402 "heartbeat" job.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Coinbase CDP x402 Bazaar discovery registry auto-indexes resources from
 * the authenticated **mainnet** `/verify` traffic the CDP facilitator observes
 * for a resource (resource URL + payTo + CDP account). Each registry record
 * carries a `lastUpdated` timestamp and ages out on a recency/TTL basis. There
 * is NO client-side publish/register API — the only way to (re)appear and stay
 * listed is for the facilitator to keep seeing fresh, successful, authenticated
 * mainnet paid verifies. Toolstem aged out of the Bazaar after mainnet paid
 * traffic went quiet (see ../bazaar_fix.md for the full analysis).
 *
 * WHAT THIS DOES
 * --------------
 * On each run it makes a small number of GENUINE paid x402 `tools/call`s to
 * Toolstem's own hosted endpoints on Base mainnet (`eip155:8453`):
 *   1. POST https://mcp.toolstem.com/mcp/finance  -> get_stock_snapshot  (~$0.01)
 *   2. POST https://mcp.toolstem.com/mcp/sec       -> get_company_filings_summary (~$0.005)
 * Total ~$0.015 per run. Each successful call is exactly the authenticated
 * mainnet verify the facilitator needs to keep the resource indexed.
 *
 * It signs an EIP-3009 USDC transferWithAuthorization and retries with the
 * payment header using the SAME x402 client flow as the `langchain-toolstem`
 * package (@x402/core + @x402/evm), so the wire format matches production.
 *
 * SAFETY
 * ------
 * - The wallet key and (optional) CDP creds come ONLY from env vars, by name.
 *   Nothing is hardcoded, printed, or committed.
 * - A `maxPaymentUsd` cap (default $0.02) is enforced as a payment policy: any
 *   quoted requirement above the cap is filtered out and the call aborts rather
 *   than paying. The two heartbeat tools are the cheapest tiers, well under it.
 * - Payments are pinned to Base mainnet (eip155:8453): the scheme is registered
 *   only for mainnet and a network policy + an explicit pre-payment assertion
 *   reject any non-mainnet (e.g. testnet) quote, failing closed.
 * - If required env vars are missing, the job exits cleanly WITHOUT attempting
 *   any network/payment call.
 * - Logs are non-sensitive only: resource, ok/fail, amount, and tx hash if the
 *   server returns one. The private key is never logged.
 *
 * RUN
 * ---
 *   HEARTBEAT_WALLET_PRIVATE_KEY=0x... npx tsx heartbeat/heartbeat.ts
 *
 * Requires deps already in this repo: @x402/core, @x402/evm, viem.
 */

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

// ---- Configuration (no secrets here; only public, non-sensitive constants) ----

const NETWORK = "eip155:8453"; // Base MAINNET. Sepolia (84532) does NOT feed the mainnet catalog.

const FINANCE_URL = "https://mcp.toolstem.com/mcp/finance";
const SEC_URL = "https://mcp.toolstem.com/mcp/sec";

// Default per-call cap. Clears the two intended tiers ($0.01 Finance, $0.005
// SEC) with margin, but fails closed against any standard ($0.05) or premium
// ($0.50) tool so a misconfig/mis-quote can never pay a pricier tool. Operators
// can still raise it via HEARTBEAT_MAX_PAYMENT_USD if ever needed.
const DEFAULT_MAX_PAYMENT_USD = 0.02;

interface HeartbeatTarget {
  label: string;
  url: string;
  toolName: string;
  args: Record<string, unknown>;
  approxUsd: number;
}

const TARGETS: HeartbeatTarget[] = [
  {
    label: "finance",
    url: FINANCE_URL,
    toolName: "get_stock_snapshot",
    args: { symbol: "AAPL" },
    approxUsd: 0.01,
  },
  {
    label: "sec",
    url: SEC_URL,
    toolName: "get_company_filings_summary",
    args: { ticker_or_cik: "AAPL" },
    approxUsd: 0.005,
  },
];

// ---- Env guard: exit cleanly if the wallet key is absent. No call attempted. ----

const rawKey = process.env.HEARTBEAT_WALLET_PRIVATE_KEY;
if (!rawKey || rawKey.trim() === "") {
  console.error(
    "[heartbeat] HEARTBEAT_WALLET_PRIVATE_KEY is not set — refusing to run.\n" +
      "            Set it to a funded Base-mainnet wallet private key (0x-prefixed)\n" +
      "            and re-run. No network or payment call was attempted."
  );
  process.exit(1);
}

const maxPaymentUsd = (() => {
  const v = process.env.HEARTBEAT_MAX_PAYMENT_USD;
  if (!v) return DEFAULT_MAX_PAYMENT_USD;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(
      `[heartbeat] HEARTBEAT_MAX_PAYMENT_USD="${v}" is invalid — must be a positive number. Aborting.`
    );
    process.exit(1);
  }
  return n;
})();

// USDC has 6 decimals; convert the USD cap to atomic units for the policy filter.
const maxAtomic = BigInt(Math.floor(maxPaymentUsd * 1_000_000));

const pk: `0x${string}` = rawKey.startsWith("0x")
  ? (rawKey as `0x${string}`)
  : (`0x${rawKey}` as `0x${string}`);

const account = privateKeyToAccount(pk);

// ---- Build the paying x402 client (mirrors langchain-toolstem's createX402Fetch) ----

function buildPayingFetch(): typeof fetch {
  const core = new x402Client();
  // Pin the scheme to Base mainnet only. With `networks` set, the client
  // registers the exact-EVM scheme solely for eip155:8453 — any quote on a
  // different network (e.g. a testnet) has no registered scheme and is rejected
  // before a payment can be built.
  registerExactEvmScheme(core, { signer: account, networks: [NETWORK] });

  // Defense in depth: drop any quoted requirement whose network is not mainnet.
  // If the server ever mis-declares (or offers multiple networks), anything
  // non-eip155:8453 is filtered out here. If that empties the list the client
  // throws and the call fails closed — no non-mainnet payment is ever signed.
  core.registerPolicy((_version, reqs) =>
    reqs.filter((r) => r.network === NETWORK)
  );

  // Safety cap: drop any quoted requirement above maxAtomic. If everything is
  // filtered out, the client cannot construct a payment and the call fails
  // closed (no overpayment).
  core.registerPolicy((_version, reqs) =>
    reqs.filter((r) => {
      try {
        return BigInt(r.amount) <= maxAtomic;
      } catch {
        return false;
      }
    })
  );

  const http = new x402HTTPClient(core);

  const payingFetch: typeof fetch = async (input, init) => {
    const baseFetch = globalThis.fetch;
    const first = await baseFetch(input as RequestInfo, init);
    if (first.status !== 402) return first;

    const getHeader = (name: string) => first.headers.get(name);

    let bodyForV1: unknown;
    try {
      bodyForV1 = await first.clone().json();
    } catch {
      bodyForV1 = undefined;
    }

    const paymentRequired = http.getPaymentRequiredResponse(getHeader, bodyForV1);

    // Explicit mainnet assertion BEFORE any payment is built: every quoted
    // requirement in the challenge must be on Base mainnet. If the server
    // declares anything else, abort without paying. This is redundant with the
    // network policy above but gives a clear, early failure reason.
    const accepts = (paymentRequired as { accepts?: Array<{ network?: string }> })
      .accepts;
    if (
      Array.isArray(accepts) &&
      accepts.length > 0 &&
      !accepts.some((a) => a.network === NETWORK)
    ) {
      throw new Error(
        `non-mainnet network: challenge offered ${JSON.stringify(
          accepts.map((a) => a.network)
        )}, expected ${NETWORK}`
      );
    }

    const paymentPayload = await http.createPaymentPayload(paymentRequired);
    const paymentHeaders = http.encodePaymentSignatureHeader(paymentPayload);

    const retryHeaders = new Headers(init?.headers as HeadersInit | undefined);
    for (const [k, v] of Object.entries(paymentHeaders)) {
      retryHeaders.set(k, v);
    }

    return baseFetch(input as RequestInfo, {
      ...(init ?? {}),
      headers: retryHeaders,
    });
  };

  return payingFetch;
}

// ---- Extract a tx/settlement hash from the response, if the server returns one ----

function findTxHash(headers: Headers, body: string): string | undefined {
  // x402 settle responses commonly surface a tx hash via a response header.
  for (const h of ["x-payment-response", "payment-response", "x-settlement-tx"]) {
    const val = headers.get(h);
    if (val) {
      const m = val.match(/0x[a-fA-F0-9]{64}/);
      if (m) return m[0];
    }
  }
  const m = body.match(/0x[a-fA-F0-9]{64}/);
  return m ? m[0] : undefined;
}

// ---- Run one paid call against a single target ----

async function runTarget(
  payingFetch: typeof fetch,
  t: HeartbeatTarget
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const res = await payingFetch(t.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: t.toolName, arguments: t.args },
      }),
    });

    const elapsed = Date.now() - startedAt;
    const body = await res.text();

    if (res.status === 200) {
      const tx = findTxHash(res.headers, body);
      console.log(
        `[heartbeat] OK   resource=${t.label} tool=${t.toolName} ` +
          `status=200 approx=$${t.approxUsd.toFixed(3)} elapsedMs=${elapsed}` +
          (tx ? ` tx=${tx}` : "")
      );
      return true;
    }

    console.error(
      `[heartbeat] FAIL resource=${t.label} tool=${t.toolName} ` +
        `status=${res.status} elapsedMs=${elapsed} ` +
        `bodyHead=${JSON.stringify(body.slice(0, 200))}`
    );
    return false;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[heartbeat] FAIL resource=${t.label} tool=${t.toolName} error=${JSON.stringify(msg)}`
    );
    return false;
  }
}

// ---- Main: run all targets, exit non-zero if any failed (for cron alerting) ----

async function main() {
  console.log(
    `[heartbeat] start network=${NETWORK} payer=${account.address} ` +
      `maxPaymentUsd=$${maxPaymentUsd.toFixed(3)} targets=${TARGETS.length}`
  );

  const payingFetch = buildPayingFetch();

  let failures = 0;
  for (const t of TARGETS) {
    const ok = await runTarget(payingFetch, t);
    if (!ok) failures += 1;
  }

  const total = TARGETS.reduce((s, t) => s + t.approxUsd, 0);
  console.log(
    `[heartbeat] done ok=${TARGETS.length - failures} fail=${failures} ` +
      `approxSpendThisRun=$${total.toFixed(3)}`
  );

  // Exit non-zero if anything failed so a scheduler/CI surfaces it.
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[heartbeat] fatal error=${JSON.stringify(msg)}`);
  process.exit(1);
});
