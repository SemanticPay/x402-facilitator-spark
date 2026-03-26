# Plan: Apply Manager's Code Review Comments

## Overview
Simplify the x402 facilitator into an invoice-based flow. Remove the facilitator process entirely, drop L1/Lightning support, and use Spark's native invoice verification inline in the server.

---

## Step 1: Clean up types (`src/types.ts`)
- Remove `L1` and `LIGHTNING` from `SparkPaymentType` — only keep `SPARK`
- Remove fields: `preimage`, `txid`, `depositAddress`, `lightningInvoice` from extra
- Remove `SettleRequest`, `SettleResponse`, `VerifyRequest` interfaces (facilitator protocol)
- Add `sparkInvoice` as the primary proof field in `PaymentPayload`
- Simplify `PaymentRequirements.extra` to just `{ sparkInvoice: string }`
- Remove `paymentId` — the invoice string itself is the identifier

## Step 2: Delete the facilitator (`src/facilitator/`)
- Delete `src/facilitator/sparkExactFacilitator.ts`
- Delete `src/facilitator/paymentStore.ts`
- Delete `src/facilitator/index.ts`
- Remove `"facilitator"` script from `package.json`

## Step 3: Rewrite the server (`src/server/index.ts`)
- Remove all facilitator HTTP calls (`POST /verify`, `POST /settle`)
- Remove Lightning invoice creation (`wallet.createLightningInvoice`)
- Remove `paymentId` UUID generation — use invoice string as the identifier
- Inline verification: call `wallet.querySparkInvoices([sparkInvoice])` directly
- Add `usedInvoices` Set with TTL-based eviction for replay protection
- 402 response returns only: `{ scheme: "exact", network: "spark", amount, extra: { sparkInvoice } }`
- On valid payment: serve resource, no settle call

## Step 4: Rewrite the client (`src/client/index.ts`)
- Replace `wallet.transfer()` with `wallet.fulfillSparkInvoice([{ invoice: sparkInvoice }])`
- Extract `sparkInvoice` from the 402 response's `extra` field
- Send invoice string as proof in `X-PAYMENT` header instead of `transfer_id`
- Remove dead code paths for Lightning/L1 payment types

## Step 5: Clean up `package.json`
- Remove `light-bolt11-decoder` dependency
- Remove `"facilitator"` script
- Keep `server`, `client`, `generate-wallets`, `test`

## Step 6: Update tests (`src/test/`)
- Update integration test to match new flow (invoice-based, no facilitator)

---

## New Flow (after changes)
```
Client → GET /weather → 402 { sparkInvoice: "spark1q..." }
Client → wallet.fulfillSparkInvoice([{ invoice }])
Client → GET /weather + X-PAYMENT: { sparkInvoice: "spark1q..." }
Server → wallet.querySparkInvoices([invoice]) → PAID? → 200 + resource
```

## API Signatures (from Spark docs)

### `wallet.createSatsInvoice(opts): Promise<SparkAddressFormat>`
```ts
// opts: { amount?: number, memo?: string, expiryTime?: Date, senderSparkAddress?, receiverIdentityPubkey? }
const invoice = await wallet.createSatsInvoice({ amount: 1000, memo: "resourceHash" });
// returns "spark1..." string
```
- `expiryTime` is useful — set it so we know when to evict from usedInvoices

### `wallet.fulfillSparkInvoice(invoices): Promise<FulfillSparkInvoiceResponse>`
```ts
// invoices: { invoice: SparkAddressFormat, amount?: bigint }[]
const result = await wallet.fulfillSparkInvoice([{ invoice: "spark1..." }]);
// result.satsTransactionSuccess / satsTransactionErrors / invalidInvoices
```
- Amount is `bigint` (e.g. `1000n`), only needed if invoice has no encoded amount
- Only `spark1...` prefix supported (not older `sp1...`)

### `wallet.querySparkInvoices(invoices): Promise<QuerySparkInvoicesResponse>`
```ts
const status = await wallet.querySparkInvoices(["spark1..."]);
```
- **NOTE**: exact response shape not fully documented. Need to check SDK types for `QuerySparkInvoicesResponse` at implementation time. Manager assumed `results[invoice] → PAID/UNPAID/EXPIRED` but actual shape may differ.

## API References
- https://docs.spark.money/api-reference/wallet/create-sats-invoice
- https://docs.spark.money/api-reference/wallet/fulfill-spark-invoice
- https://docs.spark.money/api-reference/wallet/query-spark-invoices
