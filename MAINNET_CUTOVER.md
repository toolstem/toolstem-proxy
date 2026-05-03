# Mainnet cutover — one-line flip

After validating end-to-end on Base Sepolia (TX
`0xc19b4bbe57ef0e3d70175f48e6b61eb6dc1c71b1d2610e029b6d8074873c8678`,
2026-05-03), the production switch to Base mainnet is a single env var.

## What flips

| Var | Sepolia (current) | Mainnet (production) |
|---|---|---|
| `X402_NETWORK` | `eip155:84532` | `eip155:8453` |
| USDC contract (auto-resolved by `@x402/evm`) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Facilitator | `https://www.x402.org/facilitator` | same |
| `PAYTO_ADDRESS` (CEO wallet) | same | same |

Nothing else changes:
- Same Worker
- Same Apify gateway, same actors, same Bearer auth
- Same test page (it derives `chainId` from the 402 challenge's `network` field)
- Same code paths — `parsePrice` in `@x402/evm` reads its own network table
  to map `eip155:8453 → 0x833589f…` USDC

## How to flip

```bash
# 1. Edit wrangler.toml — change ONE LINE
#    X402_NETWORK = "eip155:84532"   →   X402_NETWORK = "eip155:8453"

# 2. Commit + push (auto-deploy via GitHub Actions)
git add wrangler.toml
git commit -m "feat: cutover to Base mainnet (eip155:8453)"
git push origin main
```

That's it. The Worker re-initializes with mainnet on cold start; the
facilitator client and ExactEvmScheme are network-agnostic.

## Pre-cutover checklist

- [ ] Real USDC in `PAYTO_ADDRESS` on Base mainnet — to demo flow with a
      funded test wallet. (For self-pay self-receive, any tiny amount is
      fine; the AuthorizationUsed event is what proves the rail.)
- [ ] Confirm `PAYTO_ADDRESS` wallet still controls the same EOA on
      mainnet (it does — same private key works on every EVM chain).
- [ ] Glama / Smithery / PulseMCP listings ready to update with
      "now accepts real USDC on Base mainnet" announcement.
- [ ] Show HN paste references the mainnet TX hash (not the testnet
      one) — schedule the cutover ~24h before the paste to bake in
      receipts.

## Post-cutover validation

```bash
# 1. Hit /test in browser → click pay → confirm flow
# 2. Inspect TX on https://basescan.org/tx/<hash>
# 3. Check Worker observability tab for any errors in the first hour
# 4. Roll back instantly if needed: revert wrangler.toml, git push
```

## Why this is one-line safe

The library `@x402/evm` ships a complete network table at
`node_modules/@x402/evm/dist/cjs/index.js:1122` containing both Base
mainnet (`eip155:8453 → 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
and Base Sepolia. `parsePrice` looks up the correct USDC contract
purely from the network string; we never hardcode an asset address
in `index.ts` (we only pass `price: "$0.01"` and `network`).

The test page now derives `chainId` from the 402 challenge's
`network` field at runtime, so a single static page works against
either network without rebuilding.
