# Implementation Plan: x402 Spark Facilitator

## Project Structure

```
x402-facilitator-spark/
├── package.json
├── tsconfig.json
├── .nvmrc                          # Node >= 20.6.0 required (Spark SDK gRPC dependency)
├── design.md
├── PLAN.md
├── src/
│   ├── types.ts                    # Spark-specific x402 types
│   ├── generate-wallets.ts         # Utility to create testnet/mainnet wallet mnemonics
│   ├── facilitator/
│   │   ├── index.ts                # Express server with /verify, /settle, /supported
│   │   ├── sparkExactFacilitator.ts # SchemeNetworkFacilitator implementation
│   │   └── paymentStore.ts         # In-memory replay protection + idempotency + delivery log
│   ├── server/
│   │   └── index.ts                # Test resource server (issues 402s with Spark invoices)
│   └── client/
│       └── index.ts                # Test client (pays + retries)
└── .env.example
```

## Step 1: Project scaffolding

- `package.json` with dependencies: `@buildonspark/spark-sdk`, `express`, `dotenv`, `typescript`, `tsx`, `light-bolt11-decoder` (BOLT11 parsing)
- `tsconfig.json` targeting ES2022/NodeNext
- `.env.example` with placeholders for mnemonics/config

## Step 2: Types (`src/types.ts`)

```ts
type SparkPaymentType = "SPARK" | "LIGHTNING" | "L1";

// X-PAYMENT payload.payload shape
interface SparkPaymentPayload {
  paymentType: SparkPaymentType;
  transfer_id?: string;   // Spark direct
  preimage?: string;       // Lightning
  txid?: string;           // L1
}

// PaymentRequirements.extra fields
interface SparkPaymentExtra {
  lightningInvoice?: string;  // BOLT11 invoice string
  depositAddress?: string;
  paymentId: string;          // Unique per-request ID for replay protection + correlation
  resourceHash: string;       // SHA256(resource URL) for cross-resource binding
}

// X-PAYMENT-RESPONSE shape — proof field varies by payment type
interface SparkPaymentResponse {
  success: boolean;
  network: "spark";
  paymentType: SparkPaymentType;
  transfer_id?: string;       // Spark
  preimage?: string;          // Lightning
  txid?: string;              // L1
}
```

## Step 3: Payment store (`src/facilitator/paymentStore.ts`)

In-memory store handling three concerns:

```ts
class PaymentStore {
  // 1. Replay protection — reject reuse of proof across different requests
  private usedProofs: Map<string, string>;  // proof → paymentId that first used it

  // 2. Idempotency — return cached results for repeated calls with same paymentId
  private verifyResults: Map<string, VerifyResponse>;
  private settleResults: Map<string, SettleResponse>;

  // 3. Delivery log — settle records that the resource was served (not just payment verified)
  private deliveryLog: Map<string, { settledAt: number; transaction: string }>;

  hasBeenUsed(proof: string): boolean;
  getOwningPaymentId(proof: string): string | undefined;
  markUsed(proof: string, paymentId: string): void;

  cacheVerifyResult(paymentId: string, result: VerifyResponse): void;
  getCachedVerifyResult(paymentId: string): VerifyResponse | undefined;

  cacheSettleResult(paymentId: string, result: SettleResponse): void;
  getCachedSettleResult(paymentId: string): SettleResponse | undefined;

  recordDelivery(paymentId: string, transaction: string): void;
}
```

## Step 4: Facilitator core (`src/facilitator/sparkExactFacilitator.ts`)

### verify(payload, requirements)

1. Extract `paymentId` from `requirements.extra` — reject if missing
2. Check idempotency: if cached result exists for this `paymentId`, return it
3. Extract proof key (transfer_id / preimage / txid) from `payload.payload`
4. Check replay: if proof was already used by a different `paymentId` → reject with `"payment_already_used"`
5. Check timeout: compare current time against invoice creation + `maxTimeoutSeconds` → reject if expired
6. Validate `scheme === "exact"` and `network === "spark"`
7. Branch on paymentType:

   **SPARK**:
   - Call `SparkReadonlyClient.getTransfersByIds([transfer_id])`
   - Confirm transfer exists and is finalized (not pending)
   - Confirm `recipient === requirements.payTo`
   - Confirm `amount >= requirements.amount` (accept overpayment for "exact" scheme)
   - If transfer has memo, verify it contains `resourceHash`

   **LIGHTNING**:
   - Parse BOLT11 from `requirements.extra.lightningInvoice` using `light-bolt11-decoder`
   - Verify `SHA256(preimage) === payment_hash` from parsed invoice
   - Verify invoice amount matches `requirements.amount`
   - Verify invoice has not expired
   - **Crucially**: also query the server wallet's incoming transfers via `getTransfers()` to confirm the Lightning payment was actually received by the server's wallet. Preimage alone only proves someone paid some invoice — not that our wallet got the funds.
   - Verify invoice description contains `resourceHash`

   **L1**:
   - Stub: return `isValid: false, invalidReason: "l1_not_supported_in_prototype"`

8. On success: mark proof as used, cache result
9. Return `VerifyResponse { isValid, invalidReason?, payer? }`

### Error handling strategy

SDK/network errors during verification do NOT throw through HTTP. Instead:
- Spark SDK unreachable → `{ isValid: false, invalidReason: "upstream_error", invalidMessage: "..." }`
- Transfer lookup timeout → same pattern
- The HTTP layer always returns 200 with a `VerifyResponse` body. Only truly unexpected errors (bad request shape, missing fields) return 400/500.

### settle(payload, requirements)

1. Extract `paymentId` from `requirements.extra`
2. Check idempotency: if cached settle result exists, return it
3. Look up cached verify result — if verification never passed for this paymentId, reject
4. Record delivery: `paymentStore.recordDelivery(paymentId, transaction)` — this is the meaningful action, logging that the server committed to serving the resource for this payment
5. Build and cache `SettleResponse { success, transaction, network }`
6. Return result

No network calls in settle. It relies on verification having already confirmed the payment, and adds a delivery receipt.

## Step 5: Facilitator HTTP server (`src/facilitator/index.ts`)

Express server:

- `POST /verify` — accepts `{ paymentPayload, paymentRequirements }`, calls facilitator.verify()
- `POST /settle` — accepts `{ paymentPayload, paymentRequirements }`, calls facilitator.settle()
- `GET /supported` — returns `{ kinds: [{ x402Version: 1, scheme: "exact", network: "spark" }] }`

Initializes `SparkReadonlyClient` on startup. If readonly client proves insufficient for transfer queries at implementation time, fall back to `SparkReadonlyClient.createWithMasterKey()` which is authenticated for reads but still has no spending capability.

Port: 4020 (configurable via env)

## Step 6: Test resource server (`src/server/index.ts`)

Express server:

1. Protected endpoint `GET /weather`
2. On request without valid `X-PAYMENT` header:
   - Generate unique `paymentId` (uuid)
   - Compute `resourceHash = SHA256(canonical resource URL)`
   - Create Spark invoice: `wallet.createSatsInvoice({ amount, memo: resourceHash })`
   - Create Lightning invoice: `wallet.createLightningInvoice({ amountSats, memo: resourceHash })`
   - Return 402 with `PaymentRequirements` including `extra.paymentId` and `extra.resourceHash`
3. On request WITH `X-PAYMENT` header:
   - Call facilitator `/verify`
   - If valid, return 200 with resource content + `X-PAYMENT-RESPONSE` header
   - Fire-and-forget call to facilitator `/settle` after sending 200 (async, no added latency per x402 spec guidance)

**Invoice correlation note**: Verification checks that a valid payment of the right amount went to the right address within the timeout — it does NOT require matching a specific invoice ID. The `paymentId` in `extra` binds the 402 response to the retry attempt. This avoids the freshness problem where rapid requests generate multiple invoices and the client pays one but retries against a different 402 response.

Port: 4021 (configurable via env)

## Step 7: Test client (`src/client/index.ts`)

Script that:

1. `GET /weather` → receives 402 with `PaymentRequirements`
2. Parses requirements, extracts Spark address and paymentId
3. Pays via `wallet.fulfillSparkInvoice()` or `wallet.transfer()` — both confirmed to exist in SDK
4. Constructs base64-encoded `X-PAYMENT` header with transfer_id + paymentId
5. Retries `GET /weather` with payment header
6. Logs 200 response body + decoded `X-PAYMENT-RESPONSE`

Uses its own Spark wallet (separate mnemonic).

## Step 8: Integration test flow

1. Start facilitator on :4020
2. Start resource server on :4021
3. Run client → observe: 402 → pay → retry → 200
4. Run client again reusing the same proof → observe: rejection (replay)
5. Run client against different endpoint with same proof → observe: rejection (resource binding)

## Open items / future work

- L1 deposit verification with confirmation tracking — stubbed
- Token invoice support (BTC-only for now)
- Persistent store (Redis/DB) replacing in-memory maps
- Production key management
- TTL expiry on store entries to bound memory growth
- WebSocket-driven verification instead of polling
