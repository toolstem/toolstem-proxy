# x402 Verify Debugging — Root Cause & Fix

## TL;DR

**The bug is in `/mcp/debug`'s hardcoded `requirements` object.** It uses the V1 field name `maxAmountRequired` instead of the V2 field name `amount`. The remote facilitator at `https://x402.org/facilitator` receives the `paymentRequirements` object with `amount: undefined`, calls `BigInt(requirements.amount)` = `BigInt(undefined)`, and throws "Cannot convert undefined to a BigInt". The facilitator returns this as `{ isValid: false, invalidReason: "unexpected_error", invalidMessage: "Cannot convert undefined to a BigInt" }`, and the local `HTTPFacilitatorClient.verify` re-throws it as a `VerifyError`.

---

## 1. Where `BigInt(...)` is called — exact source locations

### `@x402/evm/dist/cjs/exact/facilitator/index.js` — V2 path (line 698)

```js
// src/exact/facilitator/eip3009.ts → verifyEIP3009()
if (BigInt(eip3009Payload.authorization.value) !== BigInt(requirements.amount)) {
```

This is the function called for V2 payments (x402Version: 2) using EIP-3009. `requirements.amount` must be the amount string in the V2 `PaymentRequirementsV2Schema` shape.

### `@x402/evm/dist/cjs/exact/facilitator/index.js` — V1 path (line 1815)

```js
// src/exact/v1/facilitator/scheme.ts → _verify()
if (BigInt(exactEvmPayload.authorization.value) !== BigInt(requirementsV1.maxAmountRequired)) {
```

This is the V1 path. It uses `maxAmountRequired` from `PaymentRequirementsV1Schema`.

### Earlier BigInt calls in the same function (lines 631–633, 684, 691)

```js
value: BigInt(eip3009Payload.authorization.value),      // line 631
validAfter: BigInt(eip3009Payload.authorization.validAfter),  // line 632
validBefore: BigInt(eip3009Payload.authorization.validBefore), // line 633
...
if (BigInt(eip3009Payload.authorization.validBefore) < BigInt(now + 6)) { // line 684
if (BigInt(eip3009Payload.authorization.validAfter) > BigInt(now)) {      // line 691
```

These all use fields from the **payload's `authorization` object** (which is present in the user's payload), not `requirements`. These succeed fine.

---

## 2. Exactly which field is `undefined`

`requirements.amount` is `undefined` because the `/mcp/debug` endpoint hardcoded a **V1-style** requirements object with `maxAmountRequired` instead of a **V2-style** object with `amount`.

### V1 schema (`PaymentRequirementsV1Schema`) — `@x402/core/dist/cjs/server/index.js` line 262

```js
var PaymentRequirementsV1Schema = z.object({
  scheme: NonEmptyString,
  network: NetworkSchemaV1,
  maxAmountRequired: NonEmptyString,   // ← V1 uses this field
  resource: NonEmptyString,
  description: z.string(),
  mimeType: z.string().optional(),
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  asset: NonEmptyString,
  extra: OptionalAny
});
```

### V2 schema (`PaymentRequirementsV2Schema`) — `@x402/core/dist/cjs/server/index.js` line 287

```js
var PaymentRequirementsV2Schema = z.object({
  scheme: NonEmptyString,
  network: NetworkSchemaV2,
  amount: NonEmptyString,              // ← V2 uses this field
  asset: NonEmptyString,
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  extra: OptionalAny
  // NOTE: no resource, description, mimeType in V2 requirements
});
```

The user's request has `x402Version: 2`, so the facilitator runs the V2 verify path (`verifyEIP3009`), which accesses `requirements.amount`. The debug endpoint sent `maxAmountRequired: "10000"` — so `requirements.amount` is `undefined`.

---

## 3. The full execution path to the error

```
/mcp/debug POST
  ↓
decodePaymentSignatureHeader(header) → paymentPayload (x402Version: 2)
  ↓
hardcoded requirements = { maxAmountRequired: "10000", ... }   ← BUG: V1 field name
  ↓
rs.verifyPayment(paymentPayload, requirements)
  ↓
x402ResourceServer.verifyPayment() [server/index.js:1018]
  ↓
facilitatorClient.verify(paymentPayload, requirements) [server/index.js:1042 → http/index.js:913]
  ↓
POST https://x402.org/facilitator/verify
  body: { x402Version: 2, paymentPayload: {...}, paymentRequirements: { maxAmountRequired: "10000", amount: undefined, ... } }
  ↓
[x402.org remote facilitator]
verifyEIP3009(signer, payload, requirements, eip3009Payload)
  line 698: BigInt(requirements.amount) = BigInt(undefined) → TypeError
  [facilitator catches and returns]:
  { isValid: false, invalidReason: "unexpected_error", invalidMessage: "Cannot convert undefined to a BigInt" }
  ↓
HTTPFacilitatorClient.verify sees !response.ok
  throws new VerifyError(statusCode, data) [server/index.js:428]
  → "VerifyError: unexpected_error: Cannot convert undefined to a BigInt"
    at HTTPFacilitatorClient.verify (index.js:15476:15)
    at async x402ResourceServer.verifyPayment (index.js:16213:28)
```

---

## 4. Is the real middleware path (`/mcp/finance`) also broken?

**No.** The `paymentMiddleware` / `processHTTPRequest` path builds requirements via `buildPaymentRequirements()`, which uses the V2 schema and returns `{ ..., amount: "10000", ... }` (not `maxAmountRequired`). The facilitator then sees a proper `amount` field and `BigInt(requirements.amount)` succeeds.

The debug endpoint error does NOT mean `/mcp/finance` is broken at the BigInt level. However, see §6 for a potential secondary issue in the real middleware path.

---

## 5. The Fix — `src/index.ts`

### Primary Fix (the BigInt error)

In the `/mcp/debug` handler (around line 121 of `src/index.ts`), rename `maxAmountRequired` to `amount` and remove the V1-only fields (`resource`, `description`, `mimeType`):

**Current (broken):**
```typescript
const requirements = {
  scheme: "exact" as const,
  network,
  maxAmountRequired: "10000", // $0.01 USDC = 10000 (6 decimals)  ← BUG: V1 field name
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
  payTo: c.env.PAYTO_ADDRESS,
  resource: "https://mcp.toolstem.com/mcp/finance",       // ← V1 only
  description: "Toolstem Financial Intelligence MCP — one tool call", // ← V1 only
  mimeType: "",                                            // ← V1 only
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};
```

**Fixed (V2 shape):**
```typescript
const requirements = {
  scheme: "exact" as const,
  network,
  amount: "10000",            // V2 field name — was "maxAmountRequired"
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
  payTo: c.env.PAYTO_ADDRESS,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};
```

### Better Fix — use the resource server to build canonical requirements

Rather than hardcoding requirements that can drift from what the middleware uses, derive them from `buildPaymentRequirements` directly:

```typescript
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

  let payload: unknown;
  try {
    payload = decodePaymentSignatureHeader(header);
    out.decoded = payload;
  } catch (err) {
    out.decode_error = err instanceof Error ? err.message : String(err);
    return c.json({ ...out, error: "decode_failed" }, 400);
  }

  const network = c.env.X402_NETWORK as `${string}:${string}`;
  
  try {
    const rs = await getResourceServer(c.env);
    
    // Build requirements the same way the real middleware does — V2 shape with 'amount'
    const builtRequirements = await rs.buildPaymentRequirements({
      scheme: "exact",
      price: "$0.01",
      network,
      payTo: c.env.PAYTO_ADDRESS,
      maxTimeoutSeconds: 60,
    });
    const requirements = builtRequirements[0];
    out.requirements_used = requirements;

    const verifyResult = await rs.verifyPayment(payload as any, requirements);
    out.verify_result = verifyResult;
    return c.json(out, 200);
  } catch (err) {
    out.verify_error = err instanceof Error ? err.message : String(err);
    out.verify_stack = err instanceof Error ? err.stack?.split("\n").slice(0, 8) : undefined;
    return c.json(out, 500);
  }
});
```

---

## 6. Secondary issue: `findMatchingRequirements` deepEqual for real middleware

When a V2 payment arrives at `/mcp/finance`, `processHTTPRequest` calls `findMatchingRequirements`:

```js
// For V2:
return availableRequirements.find(
  (paymentRequirements) => deepEqual(paymentRequirements, paymentPayload.accepted)
);
```

The `paymentPayload.accepted` is copied verbatim from the 402 challenge `accepts[0]`. The challenge `accepts[0]` is built by `buildPaymentRequirements`, which returns the same V2-shaped object. So `deepEqual` should succeed.

**If deepEqual fails** (e.g., because the facilitator added extension fields to the challenge but not to requirements), the route handler returns "No matching payment requirements" (a new 402) — not the BigInt error. If you ever see that error, compare `challenge.accepts[0]` with what `buildPaymentRequirements` returns via the debug endpoint.

---

## 7. Summary of all `BigInt(undefined)` blast radius

| Location | Field accessed | Undefined if |
|---|---|---|
| `exact/facilitator/index.js:698` (V2 EIP-3009) | `requirements.amount` | V1-style requirements sent for V2 payload |
| `exact/facilitator/index.js:1815` (V1 EIP-3009) | `requirementsV1.maxAmountRequired` | V2-style requirements sent for V1 payload |
| `exact/facilitator/index.js:1225` (V2 Permit2) | `requirements.amount` | V1-style requirements sent for V2 Permit2 |
| `server/index.js:555` (settlement override) | `requirements.amount` | V1-style requirements used in settlement override path |

All cases share the same root cause: mixing V1 (`maxAmountRequired`) and V2 (`amount`) field names.

---

## 8. One-line patch

In `/home/user/workspace/toolstem-proxy/src/index.ts`, find and replace in the `/mcp/debug` handler:

```diff
-    maxAmountRequired: "10000", // $0.01 USDC = 10000 (6 decimals)
+    amount: "10000", // $0.01 USDC = 10000 (6 decimals)
```

And remove (or ignore) the V1-only fields: `resource`, `description`, `mimeType`. They are harmless extra fields and won't cause errors, but they make the requirements object not conform to `PaymentRequirementsV2Schema`.
