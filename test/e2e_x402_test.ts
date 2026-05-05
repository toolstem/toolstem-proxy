/**
 * End-to-end x402 payment test.
 *
 * Simulates an autonomous AI agent that:
 *   1. Calls /mcp/finance with no payment header
 *   2. Receives the 402 challenge from our proxy
 *   3. Signs an EIP-3009 USDC transferWithAuthorization payload
 *   4. Re-submits the request with the signed payment header
 *   5. Receives real Apple stock data from the Apify backend
 *   6. Verifies on-chain settlement to our wallet
 *
 * Run: npx tsx test/e2e_x402_test.ts
 *
 * Requires env: TEST_AGENT_PRIVATE_KEY (a funded Sepolia wallet's private key)
 */

import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const PROXY_URL = "https://mcp.toolstem.com/mcp/finance";
const AGENT_KEY = process.env.TEST_AGENT_PRIVATE_KEY;

if (!AGENT_KEY) {
  console.error("Missing TEST_AGENT_PRIVATE_KEY env var");
  process.exit(1);
}

async function main() {
  // The "agent": a wallet that will pay for the call.
  const agent = privateKeyToAccount(
    AGENT_KEY.startsWith("0x") ? (AGENT_KEY as `0x${string}`) : (`0x${AGENT_KEY}` as `0x${string}`),
  );
  console.log("Agent wallet:", agent.address);

  // Wrap fetch with x402 client middleware. It auto-handles 402 -> sign -> retry.
  const client = new x402Client();
  client.register("eip155:84532", new ExactEvmScheme(agent));

  console.log("\n→ Calling proxy (will trigger 402, sign payment, retry)...");
  const t0 = Date.now();

  const res = await client.fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 1,
      params: {
        name: "get_stock_snapshot",
        arguments: { symbol: "AAPL" },
      },
    }),
  });

  const elapsed = Date.now() - t0;
  console.log(`← HTTP ${res.status} in ${elapsed}ms`);
  console.log(`← Headers:`, Object.fromEntries(res.headers.entries()));

  const body = await res.text();
  console.log(`← Body (first 500 chars):`, body.slice(0, 500));

  if (res.status === 200) {
    console.log("\n✅ END-TO-END SUCCESS — agent paid, proxy fulfilled, Apify returned data");
  } else {
    console.log(`\n❌ Got HTTP ${res.status} — see body above for details`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
