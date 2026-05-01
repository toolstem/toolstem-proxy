# toolstem-proxy

AI-to-AI payment gateway for [Toolstem MCP servers](https://apify.com/toolstem). Agents pay per call via the [x402 protocol](https://www.x402.org/) — no Apify account, no signup, no human in the loop.

## How it works

```
Agent --(x402 payment header)--> mcp.toolstem.com (this Worker)
   Worker verifies payment via x402 facilitator
   Worker forwards request to Apify MCP gateway using pooled token
   Worker returns response to agent
```

## Endpoints

- `POST /mcp/finance` — Toolstem Financial Intelligence (stock data, financials, peers, ratios)
- `POST /mcp/sec` — Toolstem SEC EDGAR Signal Intelligence (filings, insiders, 8-K severity)
- `GET /` — service description
- `GET /health` — liveness probe

## Pricing

$0.01 per tool call (USDC on Base). Tiered pricing per tool tier rolls out post-launch.

## Why a proxy?

The native [Apify Pay-Per-Event model](https://docs.apify.com/platform/actors/publishing/monetize) requires every caller to hold an Apify token. Autonomous agents typically can't sign up for Apify, so this proxy lets them pay directly via x402 + USDC instead.

## Source

[github.com/toolstem/toolstem-proxy](https://github.com/toolstem/toolstem-proxy) — MIT licensed, audit welcome.
