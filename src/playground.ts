/**
 * /playground/* — free, walletless, cached demo responses for HN visitors.
 *
 * These routes are intentionally separated from the paid /mcp/* surface:
 *   - No x402 payment middleware
 *   - No upstream Apify call (no token spend)
 *   - Hardcoded JSON for AAPL / MSFT / GOOGL only
 *   - All responses include `meta.playground_cached: true` so callers can
 *     tell at a glance that they hit the demo path, not live data.
 *
 * Marketing site (toolstem.github.io) /playground page calls these from the
 * browser. CORS is restricted to the marketing origins + localhost for dev.
 */

import { Hono } from "hono";

const SUPPORTED_FINANCE = new Set(["AAPL", "MSFT", "GOOGL"]);
const SUPPORTED_SEC = new Set(["AAPL", "MSFT", "GOOGL"]);

const WALLET_DOCS = "https://toolstem.com/docs/";

const PLAYGROUND_NOTE =
  "Static demo data. For live data, use /mcp/finance with a wallet.";

const PLAYGROUND_NOTE_SEC =
  "Static demo data. For live data, use /mcp/sec with a wallet.";

function nowIso(): string {
  return new Date().toISOString();
}

function unsupportedFinance(): Record<string, unknown> {
  return {
    error:
      "Playground only supports AAPL, MSFT, GOOGL. Use /mcp/finance with a wallet for other symbols.",
    wallet_docs: WALLET_DOCS,
  };
}

function unsupportedSec(): Record<string, unknown> {
  return {
    error:
      "Playground only supports AAPL, MSFT, GOOGL. Use /mcp/sec with a wallet for other tickers.",
    wallet_docs: WALLET_DOCS,
  };
}

// ── Hardcoded snapshots ─────────────────────────────────────────────────────

type Snapshot = Record<string, unknown>;

const STOCK_SNAPSHOTS: Record<string, Snapshot> = {
  AAPL: {
    symbol: "AAPL",
    company_name: "Apple Inc.",
    sector: "Technology",
    industry: "Consumer Electronics",
    exchange: "NASDAQ",
    price: {
      current: 201.34,
      change: 1.42,
      change_percent: 0.71,
      day_high: 202.18,
      day_low: 199.5,
      year_high: 237.49,
      year_low: 164.08,
      distance_from_52w_high_percent: -15.22,
      distance_from_52w_low_percent: 22.71,
    },
    valuation: {
      market_cap: 3050000000000,
      market_cap_readable: "3.05T",
      pe_ratio: 30.4,
      dcf_value: 187.22,
      dcf_upside_percent: -7.02,
      dcf_signal: "OVERVALUED",
    },
    rating: {
      score: 4,
      recommendation: "Buy",
      dcf_score: 3,
      roe_score: 5,
      roa_score: 5,
      de_score: 3,
      pe_score: 3,
    },
    fundamentals_summary: {
      beta: 1.24,
      avg_volume: 58200000,
      employees: 164000,
      ipo_date: "1980-12-12",
      description:
        "Apple Inc. designs, manufactures, and markets smartphones, personal computers, tablets, wearables, and accessories worldwide.",
    },
  },
  MSFT: {
    symbol: "MSFT",
    company_name: "Microsoft Corporation",
    sector: "Technology",
    industry: "Software—Infrastructure",
    exchange: "NASDAQ",
    price: {
      current: 428.91,
      change: -2.13,
      change_percent: -0.49,
      day_high: 432.5,
      day_low: 427.4,
      year_high: 468.35,
      year_low: 362.9,
      distance_from_52w_high_percent: -8.42,
      distance_from_52w_low_percent: 18.19,
    },
    valuation: {
      market_cap: 3190000000000,
      market_cap_readable: "3.19T",
      pe_ratio: 35.1,
      dcf_value: 401.55,
      dcf_upside_percent: -6.38,
      dcf_signal: "FAIRLY VALUED",
    },
    rating: {
      score: 5,
      recommendation: "Strong Buy",
      dcf_score: 3,
      roe_score: 5,
      roa_score: 4,
      de_score: 5,
      pe_score: 3,
    },
    fundamentals_summary: {
      beta: 0.93,
      avg_volume: 19400000,
      employees: 228000,
      ipo_date: "1986-03-13",
      description:
        "Microsoft Corporation develops, licenses, and supports software, services, devices, and solutions, including Azure cloud and Microsoft 365.",
    },
  },
  GOOGL: {
    symbol: "GOOGL",
    company_name: "Alphabet Inc.",
    sector: "Communication Services",
    industry: "Internet Content & Information",
    exchange: "NASDAQ",
    price: {
      current: 168.22,
      change: 0.84,
      change_percent: 0.5,
      day_high: 169.05,
      day_low: 166.97,
      year_high: 191.75,
      year_low: 130.67,
      distance_from_52w_high_percent: -12.27,
      distance_from_52w_low_percent: 28.74,
    },
    valuation: {
      market_cap: 2070000000000,
      market_cap_readable: "2.07T",
      pe_ratio: 25.7,
      dcf_value: 175.8,
      dcf_upside_percent: 4.5,
      dcf_signal: "FAIRLY VALUED",
    },
    rating: {
      score: 5,
      recommendation: "Strong Buy",
      dcf_score: 4,
      roe_score: 5,
      roa_score: 5,
      de_score: 5,
      pe_score: 4,
    },
    fundamentals_summary: {
      beta: 1.05,
      avg_volume: 25100000,
      employees: 182500,
      ipo_date: "2004-08-19",
      description:
        "Alphabet Inc. provides online advertising services, search, cloud (Google Cloud), and other technology products through its subsidiaries including Google.",
    },
  },
};

const FILINGS_SUMMARIES: Record<string, Snapshot> = {
  AAPL: {
    ticker: "AAPL",
    cik: "0000320193",
    company_name: "Apple Inc.",
    recent_filings: [
      {
        accession_number: "0000320193-26-000045",
        form: "10-Q",
        filing_date: "2026-04-30",
        primary_doc_description: "Quarterly report for fiscal Q2 2026",
        items: [],
        sec_url:
          "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-Q",
      },
      {
        accession_number: "0000320193-26-000038",
        form: "8-K",
        filing_date: "2026-04-30",
        primary_doc_description: "Q2 2026 earnings release",
        items: ["2.02", "9.01"],
        sec_url:
          "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=8-K",
      },
      {
        accession_number: "0000320193-26-000022",
        form: "8-K",
        filing_date: "2026-02-27",
        primary_doc_description: "Annual meeting voting results",
        items: ["5.07"],
        sec_url:
          "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=8-K",
      },
    ],
    signals: {
      filing_velocity: "NORMAL",
      material_event_count_90d: 2,
      disclosure_volume_trend: "STABLE",
      latest_form_types: ["10-Q", "8-K", "4", "SC 13G/A"],
    },
  },
  MSFT: {
    ticker: "MSFT",
    cik: "0000789019",
    company_name: "Microsoft Corporation",
    recent_filings: [
      {
        accession_number: "0000789019-26-000051",
        form: "10-Q",
        filing_date: "2026-04-24",
        primary_doc_description: "Quarterly report for fiscal Q3 2026",
        items: [],
        sec_url:
          "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000789019&type=10-Q",
      },
      {
        accession_number: "0000789019-26-000049",
        form: "8-K",
        filing_date: "2026-04-24",
        primary_doc_description: "Q3 2026 earnings release",
        items: ["2.02", "9.01"],
        sec_url:
          "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000789019&type=8-K",
      },
      {
        accession_number: "0000789019-26-000031",
        form: "8-K",
        filing_date: "2026-03-12",
        primary_doc_description: "Departure of executive officer",
        items: ["5.02"],
        sec_url:
          "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000789019&type=8-K",
      },
    ],
    signals: {
      filing_velocity: "NORMAL",
      material_event_count_90d: 3,
      disclosure_volume_trend: "STABLE",
      latest_form_types: ["10-Q", "8-K", "4", "DEF 14A"],
    },
  },
  GOOGL: {
    ticker: "GOOGL",
    cik: "0001652044",
    company_name: "Alphabet Inc.",
    recent_filings: [
      {
        accession_number: "0001652044-26-000060",
        form: "10-Q",
        filing_date: "2026-04-29",
        primary_doc_description: "Quarterly report for Q1 2026",
        items: [],
        sec_url:
          "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001652044&type=10-Q",
      },
      {
        accession_number: "0001652044-26-000058",
        form: "8-K",
        filing_date: "2026-04-29",
        primary_doc_description: "Q1 2026 earnings release",
        items: ["2.02", "9.01"],
        sec_url:
          "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001652044&type=8-K",
      },
    ],
    signals: {
      filing_velocity: "NORMAL",
      material_event_count_90d: 1,
      disclosure_volume_trend: "STABLE",
      latest_form_types: ["10-Q", "8-K", "4"],
    },
  },
};

// Comparison table — keyed by sorted-symbols string for the small set of
// pairs we support. Browser hits will mostly be the default AAPL,MSFT.
const COMPARISON_DATA: Record<string, Snapshot> = {
  "AAPL,MSFT": buildComparison(["AAPL", "MSFT"]),
  "AAPL,GOOGL": buildComparison(["AAPL", "GOOGL"]),
  "GOOGL,MSFT": buildComparison(["GOOGL", "MSFT"]),
  "AAPL,GOOGL,MSFT": buildComparison(["AAPL", "GOOGL", "MSFT"]),
};

function buildComparison(symbols: string[]): Snapshot {
  // Deterministic mini-comparison using fields already in STOCK_SNAPSHOTS,
  // plus a few extra ratios to match the documented schema. This keeps
  // numbers mutually consistent across tools without re-typing them.
  const profilesBySymbol: Record<string, Snapshot> = {
    AAPL: {
      symbol: "AAPL",
      company_name: "Apple Inc.",
      sector: "Technology",
      industry: "Consumer Electronics",
      price: {
        current: 201.34,
        change_percent: 0.71,
        year_high: 237.49,
        year_low: 164.08,
        distance_from_52w_high_percent: -15.22,
      },
      valuation: {
        market_cap: 3050000000000,
        market_cap_readable: "3.05T",
        pe_ratio: 30.4,
        pb_ratio: 47.1,
        ps_ratio: 7.8,
        ev_to_ebitda: 23.6,
        dcf_value: 187.22,
        dcf_upside_percent: -7.02,
      },
      profitability: {
        gross_margin: 0.462,
        operating_margin: 0.311,
        net_margin: 0.262,
        roe: 1.524,
        roa: 0.281,
        roic: 0.578,
      },
      financial_health: {
        debt_to_equity: 1.96,
        current_ratio: 0.95,
        interest_coverage: 28.4,
      },
      growth: {
        revenue_growth_yoy: 0.043,
        earnings_growth_yoy: 0.078,
      },
      dividend: {
        dividend_yield: 0.0049,
        payout_ratio: 0.149,
      },
      rating: { score: 4, recommendation: "Buy" },
    },
    MSFT: {
      symbol: "MSFT",
      company_name: "Microsoft Corporation",
      sector: "Technology",
      industry: "Software—Infrastructure",
      price: {
        current: 428.91,
        change_percent: -0.49,
        year_high: 468.35,
        year_low: 362.9,
        distance_from_52w_high_percent: -8.42,
      },
      valuation: {
        market_cap: 3190000000000,
        market_cap_readable: "3.19T",
        pe_ratio: 35.1,
        pb_ratio: 11.4,
        ps_ratio: 12.6,
        ev_to_ebitda: 24.9,
        dcf_value: 401.55,
        dcf_upside_percent: -6.38,
      },
      profitability: {
        gross_margin: 0.696,
        operating_margin: 0.443,
        net_margin: 0.364,
        roe: 0.382,
        roa: 0.18,
        roic: 0.291,
      },
      financial_health: {
        debt_to_equity: 0.31,
        current_ratio: 1.27,
        interest_coverage: 41.2,
      },
      growth: {
        revenue_growth_yoy: 0.151,
        earnings_growth_yoy: 0.198,
      },
      dividend: {
        dividend_yield: 0.0073,
        payout_ratio: 0.252,
      },
      rating: { score: 5, recommendation: "Strong Buy" },
    },
    GOOGL: {
      symbol: "GOOGL",
      company_name: "Alphabet Inc.",
      sector: "Communication Services",
      industry: "Internet Content & Information",
      price: {
        current: 168.22,
        change_percent: 0.5,
        year_high: 191.75,
        year_low: 130.67,
        distance_from_52w_high_percent: -12.27,
      },
      valuation: {
        market_cap: 2070000000000,
        market_cap_readable: "2.07T",
        pe_ratio: 25.7,
        pb_ratio: 7.1,
        ps_ratio: 6.4,
        ev_to_ebitda: 17.8,
        dcf_value: 175.8,
        dcf_upside_percent: 4.5,
      },
      profitability: {
        gross_margin: 0.575,
        operating_margin: 0.319,
        net_margin: 0.262,
        roe: 0.301,
        roa: 0.197,
        roic: 0.27,
      },
      financial_health: {
        debt_to_equity: 0.09,
        current_ratio: 2.15,
        interest_coverage: 152.3,
      },
      growth: {
        revenue_growth_yoy: 0.139,
        earnings_growth_yoy: 0.288,
      },
      dividend: {
        dividend_yield: 0.0048,
        payout_ratio: 0.067,
      },
      rating: { score: 5, recommendation: "Strong Buy" },
    },
  };

  const companies = symbols.map((s) => profilesBySymbol[s]);

  // Pick winners using simple lookups against the picked companies.
  const minBy = <K extends string>(field: K, path: (c: Snapshot) => number) => {
    let best: { sym: string; v: number } | null = null;
    for (const c of companies) {
      const v = path(c);
      if (best === null || v < best.v) best = { sym: c.symbol as string, v };
    }
    return best?.sym ?? null;
  };
  const maxBy = (path: (c: Snapshot) => number) => {
    let best: { sym: string; v: number } | null = null;
    for (const c of companies) {
      const v = path(c);
      if (best === null || v > best.v) best = { sym: c.symbol as string, v };
    }
    return best?.sym ?? null;
  };

  const rankings = {
    lowest_pe: minBy("pe", (c) => (c.valuation as Snapshot).pe_ratio as number),
    highest_margin: maxBy(
      (c) => (c.profitability as Snapshot).net_margin as number,
    ),
    strongest_balance_sheet: minBy(
      "de",
      (c) => (c.financial_health as Snapshot).debt_to_equity as number,
    ),
    best_growth: maxBy(
      (c) => (c.growth as Snapshot).revenue_growth_yoy as number,
    ),
    most_undervalued: maxBy(
      (c) => (c.valuation as Snapshot).dcf_upside_percent as number,
    ),
    highest_rated: maxBy((c) => (c.rating as Snapshot).score as number),
  };

  return {
    symbols_compared: symbols,
    comparison_date: "2026-05-04",
    companies,
    rankings,
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

export const playground = new Hono();

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=3600",
};

function withCache<T extends Record<string, unknown>>(
  payload: T,
  noteOverride?: string,
): Response {
  const enriched = {
    ...payload,
    meta: {
      ...((payload.meta as Record<string, unknown> | undefined) ?? {}),
      playground_cached: true,
      cached_at: nowIso(),
      note: noteOverride ?? PLAYGROUND_NOTE,
    },
  };
  return new Response(JSON.stringify(enriched), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...CACHE_HEADERS,
    },
  });
}

playground.get("/", (c) =>
  c.json({
    service: "toolstem-playground",
    description:
      "Free, walletless cached demo responses for the Toolstem MCP servers. AAPL / MSFT / GOOGL only. For live data and any other symbol, use the paid /mcp/* endpoints with an x402 wallet.",
    supported_symbols: ["AAPL", "MSFT", "GOOGL"],
    endpoints: {
      "GET /playground/get_stock_snapshot?symbol=AAPL":
        "Cached finance snapshot (price, valuation, rating, fundamentals).",
      "GET /playground/get_company_filings_summary?ticker=AAPL":
        "Cached SEC filings summary (recent filings + signals).",
      "GET /playground/compare_companies?symbols=AAPL,MSFT":
        "Cached side-by-side comparison with derived rankings.",
    },
    paid_endpoints: {
      "/mcp/finance": "Live finance MCP (3 tools) — wallet required.",
      "/mcp/sec": "Live SEC MCP (5 tools) — wallet required.",
    },
    wallet_docs: WALLET_DOCS,
  }),
);

playground.get("/get_stock_snapshot", (c) => {
  const symbolRaw = c.req.query("symbol");
  if (!symbolRaw) {
    return c.json(
      {
        error: "Missing required query parameter: symbol",
        wallet_docs: WALLET_DOCS,
      },
      400,
    );
  }
  const symbol = symbolRaw.toUpperCase();
  if (!SUPPORTED_FINANCE.has(symbol)) {
    return c.json(unsupportedFinance(), 400);
  }
  return withCache(STOCK_SNAPSHOTS[symbol]);
});

playground.get("/get_company_filings_summary", (c) => {
  const tickerRaw = c.req.query("ticker") ?? c.req.query("ticker_or_cik");
  if (!tickerRaw) {
    return c.json(
      {
        error: "Missing required query parameter: ticker",
        wallet_docs: WALLET_DOCS,
      },
      400,
    );
  }
  const ticker = tickerRaw.toUpperCase();
  if (!SUPPORTED_SEC.has(ticker)) {
    return c.json(unsupportedSec(), 400);
  }
  return withCache(FILINGS_SUMMARIES[ticker], PLAYGROUND_NOTE_SEC);
});

playground.get("/compare_companies", (c) => {
  const symbolsRaw = c.req.query("symbols");
  if (!symbolsRaw) {
    return c.json(
      {
        error:
          "Missing required query parameter: symbols (comma-separated, e.g. AAPL,MSFT)",
        wallet_docs: WALLET_DOCS,
      },
      400,
    );
  }
  const symbols = symbolsRaw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length < 2 || symbols.length > 5) {
    return c.json(
      {
        error: "symbols must contain 2 to 5 tickers",
        wallet_docs: WALLET_DOCS,
      },
      400,
    );
  }
  for (const s of symbols) {
    if (!SUPPORTED_FINANCE.has(s)) {
      return c.json(unsupportedFinance(), 400);
    }
  }
  const key = [...symbols].sort().join(",");
  const data = COMPARISON_DATA[key];
  if (!data) {
    return c.json(
      {
        error:
          "Playground only supports comparisons of AAPL, MSFT, GOOGL. Use /mcp/finance with a wallet for arbitrary comparisons.",
        wallet_docs: WALLET_DOCS,
      },
      400,
    );
  }
  return withCache(data);
});

// ── CORS for playground routes ──────────────────────────────────────────────
//
// The marketing site (https://toolstem.com, https://www.toolstem.com) and
// local dev (http://localhost:*) call these from the browser. We also allow
// Claude Desktop, which advertises itself in the User-Agent — handy because
// some agent harnesses don't send an Origin at all.
const ALLOWED_ORIGIN_EXACT = new Set([
  "https://toolstem.com",
  "https://www.toolstem.com",
  "https://toolstem.github.io",
]);

export function isAllowedPlaygroundOrigin(
  origin: string | null,
  userAgent: string | null,
): { allow: boolean; allowOrigin: string | null } {
  if (!origin) {
    // No Origin header: likely a server-side fetch or Claude Desktop. Allow,
    // but echo nothing in Access-Control-Allow-Origin (browsers will not
    // enforce CORS without a request Origin).
    if (userAgent && /Claude/i.test(userAgent)) {
      return { allow: true, allowOrigin: null };
    }
    return { allow: true, allowOrigin: null };
  }
  if (ALLOWED_ORIGIN_EXACT.has(origin)) {
    return { allow: true, allowOrigin: origin };
  }
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) {
    return { allow: true, allowOrigin: origin };
  }
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
    return { allow: true, allowOrigin: origin };
  }
  return { allow: false, allowOrigin: null };
}
