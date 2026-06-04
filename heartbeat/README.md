# Toolstem mainnet heartbeat

A small, self-contained job that makes a few **genuine** paid x402 calls to
Toolstem's own hosted MCP endpoints on **Base mainnet** so the endpoints stay
listed in the Coinbase CDP x402 Bazaar discovery registry (and incidentally
generate tiny real revenue activity).

## Why this is needed

The Bazaar discovery registry (`/platform/v2/x402/discovery/resources` on the
CDP facilitator) is **auto-indexed from the authenticated mainnet `/verify`
traffic** the facilitator observes for a resource — keyed by resource URL +
`payTo` + the CDP account behind the Worker's `CDP_API_KEY_ID`/`SECRET`. Each
registry record carries a `lastUpdated` timestamp and **ages out on a
recency/TTL basis**. There is **no client-side publish/register API** — the only
way to (re)appear and stay listed is to keep the facilitator seeing fresh,
successful, authenticated **mainnet** paid verifies.

Toolstem listed on **2026-05-04** and had dropped off the registry by
**2026-06-04** after mainnet paid traffic went quiet. (Testnet/Sepolia
`eip155:84532` verifies do **not** feed the mainnet catalog.) See
[`../bazaar_fix.md`](../bazaar_fix.md) for the full mechanism analysis.

This heartbeat is the documented recurrence-prevention measure: a scheduled
trickle of real mainnet paid calls keeps `lastUpdated` fresh.

## What it does, per run

| # | Resource | Tool | Args | Approx charge |
|---|----------|------|------|---------------|
| 1 | `https://mcp.toolstem.com/mcp/finance` | `get_stock_snapshot` | `{ "symbol": "AAPL" }` | **$0.01** |
| 2 | `https://mcp.toolstem.com/mcp/sec` | `get_company_filings_summary` | `{ "ticker_or_cik": "AAPL" }` | **$0.005** (lowest SEC tier) |

**Total ≈ $0.015 per run.** Each call: hits the endpoint, receives the HTTP 402
challenge, signs an EIP-3009 USDC `transferWithAuthorization`, retries with the
payment header, and (on success) receives the tool result. This is the same
x402 client flow `langchain-toolstem` uses (`@x402/core` + `@x402/evm`), so the
wire format matches production.

## Environment variables

Set these by name in your scheduler's secret store / host env. **Never commit a
filled-in `.env`.** See [`.env.example`](./.env.example).

| Var | Required | Purpose |
|-----|----------|---------|
| `HEARTBEAT_WALLET_PRIVATE_KEY` | **Yes** | Funded Base **mainnet** wallet private key (`0x`-prefixed). Signs the USDC payments. The script reads this by name only; it is never printed or logged. |
| `HEARTBEAT_MAX_PAYMENT_USD` | No (default `0.02`) | Hard per-call safety cap. Clears the two intended tiers ($0.01 + $0.005) with margin but stays below any standard ($0.05) or premium ($0.50) tool, so a mis-quote can never overpay. Any quoted requirement above this is filtered out and the call aborts. |

**Not read by this script** (documented for the operator): `CDP_API_KEY_ID` and
`CDP_API_KEY_SECRET` are the **Worker's** secrets used by the deployed
`toolstem-proxy` to authenticate `/verify` with the CDP facilitator. The
heartbeat does not call the facilitator directly, so it does not need them — but
they must be **current on the Worker** for verifies to succeed, and you'll use
them for the discovery-GET verification below.

### Wallet funding

The wallet needs a small **USDC** balance on Base mainnet (a few cents covers
many runs) plus a little **ETH on Base** for L2 gas. At ~$0.015/run, $5 of USDC
is ~300 runs.

## How to run

From the repo root (deps `@x402/core`, `@x402/evm`, `viem` are already in this
repo's `package.json`):

```bash
npm install            # if node_modules isn't present
HEARTBEAT_WALLET_PRIVATE_KEY=0x... npx tsx heartbeat/heartbeat.ts
```

If `HEARTBEAT_WALLET_PRIVATE_KEY` is missing, the job prints a clear message and
exits **without** attempting any network or payment call. It exits non-zero if
any target call fails, so a scheduler can alert on failure.

Logs are **non-sensitive only**: resource label, ok/fail, HTTP status, approx
amount, elapsed ms, and a settlement tx hash if the server returns one. The
private key is never logged.

## Recommended cadence

**Every 2 days** (cron: `17 9 */2 * *` — 09:17 on alternating days; the odd
minute avoids the top-of-hour stampede).

Reasoning: the exact registry TTL isn't published, but the observed data point
is that Toolstem went from listed (2026-05-04) to delisted (by 2026-06-04) after
roughly a month of no mainnet traffic — so the expiry window is somewhere under
~30 days. Refreshing every 2 days keeps `lastUpdated` an order of magnitude
fresher than any plausible TTL, survives a missed run or two (transient outage,
RPC hiccup) without risking delisting, and costs only ~$0.015 × ~15 runs/month.
If you want to be even more conservative, every 24h is fine; going beyond ~5–7
days starts to erode the safety margin.

### Spend

| Cadence | Per run | Runs/month | **Monthly spend** |
|---------|---------|------------|-------------------|
| Every 2 days (recommended) | ~$0.015 | ~15 | **~$0.23** |
| Daily | ~$0.015 | ~30 | ~$0.45 |

(Plus negligible Base L2 gas per payment.)

## Verifying re-listing

After a run (allow a short propagation delay), confirm the resources are indexed
with a fresh `lastUpdated`. Authenticated GET against the CDP discovery registry
using the **Worker's CDP creds** (by name — do not paste them):

```bash
# The SDK does this with CDP auth:
#   client.extensions.discovery.listResources({ type: "http" })
# Equivalent raw endpoint:
GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources
```

Look for records whose `resource` is `https://mcp.toolstem.com/mcp/finance` and
`https://mcp.toolstem.com/mcp/sec` with `payTo`
`0xB009DA692cF3EFF7567bF727b8B2F3b5BFc3383E` and a recent `lastUpdated`. Before
the first heartbeat you should see **0** matches (the baseline); after a
successful run they should reappear.

> Note on SEC pricing in the catalog: the indexing verify records the `accepts`
> for the specific tool exercised, so the SEC entry will show the
> `get_company_filings_summary` tier ($0.005), not the full $0.005–$0.50 range.
> The full range is conveyed in the route `description` and the GET discovery
> hint, which is intended. See `../bazaar_fix.md` §4.

## Safety notes

- Wallet key and CDP creds are referenced **by name only**; nothing sensitive is
  hardcoded, printed, or committed.
- The `maxPaymentUsd` cap fails **closed**: if a quote ever exceeds the cap, the
  client can't build a payment and the call errors instead of overpaying.
- Payments are **pinned to Base mainnet** (`eip155:8453`): the scheme is
  registered only for mainnet, a network policy drops any non-mainnet quote, and
  an explicit pre-payment assertion aborts a target if the challenge offers a
  non-mainnet network — so a testnet quote can never be paid.
- Idempotent and safe to run on a schedule — each run is an independent set of
  one-shot paid calls with no shared state.
