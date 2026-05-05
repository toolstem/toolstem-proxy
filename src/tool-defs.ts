/**
 * Synthesized MCP tool definitions exposed by the proxy.
 *
 * The upstream Apify gateway wraps each Toolstem actor as a SINGLE MCP tool
 * with the inner tool names hidden behind an `enum` parameter. The proxy
 * re-maps that surface so MCP clients see the true 3 (Finance) / 5 (SEC)
 * tools — names, descriptions, and per-tool input schemas — that the
 * underlying servers actually implement.
 *
 * Descriptions and schemas are pulled verbatim from the ground-truth docs
 * for each upstream server (toolstem/toolstem-mcp-server,
 * toolstem/toolstem-sec-mcp-server).
 */

export type JsonSchema = {
  type?: string;
  description?: string;
  enum?: readonly string[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  additionalProperties?: boolean | JsonSchema;
};

export type ToolDef = {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const SYMBOL_SCHEMA: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 10,
  pattern: "^[A-Za-z0-9.^=-]+$",
  description: "Stock ticker symbol (e.g., AAPL, MSFT, TSLA)",
};

export const FINANCE_TOOLS: readonly ToolDef[] = [
  {
    name: "get_stock_snapshot",
    title: "Stock Snapshot",
    description:
      "Get a comprehensive stock snapshot including real-time price, valuation metrics, DCF analysis, and analyst ratings for any publicly traded company. Returns curated, agent-ready data synthesized from multiple sources in a single call — includes derived signals like dcf_signal (UNDERVALUED/FAIRLY VALUED/OVERVALUED), human-readable market cap, and 52-week range distance. Use this when you need a quick overview of a stock before digging into financials.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: SYMBOL_SCHEMA,
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    annotations: { title: "Stock Snapshot", ...READONLY_ANNOTATIONS },
  },
  {
    name: "get_company_metrics",
    title: "Company Metrics",
    description:
      "Deep financial analysis including profitability, financial health, cash flow, growth (3-year CAGR), and per-share metrics. Synthesizes key metrics, financial ratios, income statement, balance sheet, and cash flow statement into one agent-ready response with derived signals: margin_trend (EXPANDING/STABLE/CONTRACTING), health_signal (STRONG/ADEQUATE/WEAK), and growth_signal (ACCELERATING/STEADY/DECELERATING). Use this for fundamental analysis, financial health checks, or when you need to understand a company's trajectory.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: SYMBOL_SCHEMA,
        period: {
          type: "string",
          enum: ["annual", "quarter"],
          default: "annual",
          description: "Reporting period. Defaults to annual.",
        },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    annotations: { title: "Company Metrics", ...READONLY_ANNOTATIONS },
  },
  {
    name: "compare_companies",
    title: "Company Comparison",
    description:
      "Side-by-side comparison of 2-5 companies across price, valuation (P/E, P/B, P/S, EV/EBITDA, DCF), profitability (margins, ROE, ROA, ROIC), financial health (D/E, current ratio, interest coverage), growth (revenue and earnings YoY), dividends, and analyst ratings. Returns derived rankings showing which company leads each dimension — lowest_pe, highest_margin, strongest_balance_sheet, best_growth, most_undervalued, highest_rated. Use this for investment comparisons, competitive analysis, or evaluating alternatives in the same sector.",
    inputSchema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          minItems: 2,
          maxItems: 5,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 10,
            pattern: "^[A-Za-z0-9.^=-]+$",
          },
          description:
            "2-5 stock ticker symbols to compare (e.g., [\"AAPL\", \"MSFT\", \"GOOGL\"])",
        },
      },
      required: ["symbols"],
      additionalProperties: false,
    },
    annotations: { title: "Company Comparison", ...READONLY_ANNOTATIONS },
  },
] as const;

const TICKER_OR_CIK_SCHEMA: JsonSchema = {
  type: "string",
  minLength: 1,
  description:
    "Ticker symbol (e.g. \"AAPL\") or numeric CIK (e.g. \"320193\" or \"0000320193\").",
};

export const SEC_TOOLS: readonly ToolDef[] = [
  {
    name: "get_company_filings_summary",
    title: "Company Filings Summary",
    description:
      "Retrieve a structured overview of a company's SEC filing activity. Returns the most recent 20 filings and pre-computed signals: filing velocity (ACCELERATING / NORMAL / SLOWING vs. trailing 365-day average), material event count in the last 90 days, 10-K disclosure volume trend (RISING / STABLE / FALLING), and the unique form types filed in the last 90 days. Use this as a first-pass signal before digging into insider or material-event detail.",
    inputSchema: {
      type: "object",
      properties: {
        ticker_or_cik: TICKER_OR_CIK_SCHEMA,
      },
      required: ["ticker_or_cik"],
      additionalProperties: false,
    },
    annotations: { title: "Company Filings Summary", ...READONLY_ANNOTATIONS },
  },
  {
    name: "get_insider_signal",
    title: "Insider Signal",
    description:
      "Probe insider filing activity (Form 3, 4, 4/A) for a company over a configurable lookback window. Answers: \"Are insiders filing recently?\" Returns recent Form 4 filing references and counts. NOTE: Direction-aware buy/sell signals (insider_signal, buy_count, sell_count) are null/0 in v0.1 — Form 4 XML parsing ships in v0.2.",
    inputSchema: {
      type: "object",
      properties: {
        ticker_or_cik: TICKER_OR_CIK_SCHEMA,
        lookback_days: {
          type: "integer",
          minimum: 1,
          maximum: 730,
          default: 90,
          description: "Number of calendar days to look back.",
        },
      },
      required: ["ticker_or_cik"],
      additionalProperties: false,
    },
    annotations: { title: "Insider Signal", ...READONLY_ANNOTATIONS },
  },
  {
    name: "get_institutional_signal",
    title: "Institutional Signal",
    description:
      "Probe institutional and activist investor signals for a company. Returns a live activist_risk_flag (true if any SC 13D or 13D/A was filed in the last 365 days — an activist investor has disclosed a large stake). Also lists the 13D filings and their SEC URLs. NOTE: Institutional accumulation/distribution signal (institutional_signal) and recent_13f_count are null/0 in v0.1 — quarterly 13F XBRL parsing ships in v0.2.",
    inputSchema: {
      type: "object",
      properties: {
        ticker_or_cik: TICKER_OR_CIK_SCHEMA,
        quarters_back: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 4,
          description:
            "Number of calendar quarters to look back (default 4 ≈ 1 year).",
        },
      },
      required: ["ticker_or_cik"],
      additionalProperties: false,
    },
    annotations: { title: "Institutional Signal", ...READONLY_ANNOTATIONS },
  },
  {
    name: "get_material_events_digest",
    title: "Material Events Digest",
    description:
      "Retrieve a severity-ranked digest of all 8-K and 8-K/A filings for a company within a configurable lookback window. Each event is tagged with item codes mapped to plain-English labels, categories, and severity (RED / YELLOW / GREEN). Returns redflag_count (events with any RED item) and category_counts for quick categorical analysis. Answers: \"Has this company disclosed a cybersecurity incident, restatement, or going-concern risk recently?\" Premium-tier tool. See the actor pricing page for current per-call cost.",
    inputSchema: {
      type: "object",
      properties: {
        ticker_or_cik: TICKER_OR_CIK_SCHEMA,
        lookback_days: {
          type: "integer",
          minimum: 1,
          maximum: 1825,
          default: 365,
          description: "Number of calendar days to include (max 5 years).",
        },
      },
      required: ["ticker_or_cik"],
      additionalProperties: false,
    },
    annotations: { title: "Material Events Digest", ...READONLY_ANNOTATIONS },
  },
  {
    name: "compare_disclosure_signals",
    title: "Compare Disclosure Signals",
    description:
      "Side-by-side comparison of 2-5 companies across key SEC disclosure signals: filing velocity, material event count (90d), red-flag count (365d), activist risk flag, and most recent filing date. Returns derived \"winners\" for each dimension — quietest disclosure, most active filer, most red flags, and companies with active activist investors. All lookups run in parallel. Use for competitive intelligence or risk triage across a watchlist.",
    inputSchema: {
      type: "object",
      properties: {
        tickers_or_ciks: {
          type: "array",
          minItems: 2,
          maxItems: 5,
          items: { type: "string", minLength: 1 },
          description:
            "2-5 ticker symbols or CIKs to compare (e.g. [\"AAPL\", \"MSFT\", \"GOOGL\"]).",
        },
      },
      required: ["tickers_or_ciks"],
      additionalProperties: false,
    },
    annotations: { title: "Compare Disclosure Signals", ...READONLY_ANNOTATIONS },
  },
] as const;

/**
 * Names of the upstream wrapper tools we re-map. Anything else that the
 * upstream returns from `tools/list` (notably `get-actor-output`) is dropped.
 */
export const UPSTREAM_FINANCE_WRAPPER = "toolstem--toolstem-mcp-server";
export const UPSTREAM_SEC_WRAPPER = "toolstem--toolstem-sec-mcp-server";

export type RouteKey = "finance" | "sec";

export function getToolsForRoute(route: RouteKey): readonly ToolDef[] {
  return route === "finance" ? FINANCE_TOOLS : SEC_TOOLS;
}

export function getUpstreamWrapperName(route: RouteKey): string {
  return route === "finance"
    ? UPSTREAM_FINANCE_WRAPPER
    : UPSTREAM_SEC_WRAPPER;
}

/**
 * Validate a `tools/call` arguments object against a synthesized tool's
 * inputSchema. Returns null on success, or a string describing the first
 * violation. Implementation is intentionally narrow — we only need to
 * support the constructs used in FINANCE_TOOLS / SEC_TOOLS.
 */
export function validateToolArguments(
  tool: ToolDef,
  args: unknown,
): string | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be an object";
  }
  const obj = args as Record<string, unknown>;
  const schema = tool.inputSchema;
  const required = schema.required ?? [];
  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined) {
      return `missing required argument: ${key}`;
    }
  }
  const props = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in props)) {
        return `unexpected argument: ${key}`;
      }
    }
  }
  for (const [key, sub] of Object.entries(props)) {
    if (!(key in obj) || obj[key] === undefined) continue;
    const err = validateValue(obj[key], sub, key);
    if (err) return err;
  }
  return null;
}

function validateValue(
  value: unknown,
  schema: JsonSchema,
  path: string,
): string | null {
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return `${path}: expected string`;
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `${path}: must be at least ${schema.minLength} chars`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${path}: must be at most ${schema.maxLength} chars`;
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        return `${path}: does not match pattern ${schema.pattern}`;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return `${path}: must be one of ${schema.enum.join(", ")}`;
      }
      return null;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return `${path}: expected integer`;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${path}: must be >= ${schema.minimum}`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${path}: must be <= ${schema.maximum}`;
      }
      return null;
    }
    case "number": {
      if (typeof value !== "number") return `${path}: expected number`;
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${path}: must be >= ${schema.minimum}`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${path}: must be <= ${schema.maximum}`;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path}: expected array`;
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path}: must have at least ${schema.minItems} items`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path}: must have at most ${schema.maxItems} items`;
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const err = validateValue(value[i], schema.items, `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    }
    default:
      return null;
  }
}
