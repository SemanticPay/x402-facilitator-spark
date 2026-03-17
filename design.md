# Design Decisions: x402 Spark Facilitator

## 1. Settlement records delivery, not payment

Unlike EVM where the facilitator submits an on-chain transaction during settlement, Spark and Lightning payments have instant finality — the money moves at payment time, not settle time. Our `settle()` therefore serves a different purpose: it records that the server accepted the payment and committed to serving the resource. This matters for crash recovery — if verify passes but the server dies before calling settle, the delivery log shows the resource was never served, giving the operator a clear reconciliation signal. Settle makes no network calls and returns a cached result, keeping it fast and idempotent.

## 2. Three payment paths, one facilitator

The scheme spec defines three payment types (SPARK, LIGHTNING, L1) that all resolve to the same Spark address. We handle all three in a single `SparkExactFacilitator` with isolated verification branches:

- **SPARK**: Look up transfer by ID via readonly client. Confirm finality, recipient, amount.
- **LIGHTNING**: Hash-check the preimage against the BOLT11 payment_hash, AND confirm via the SDK that the server's wallet actually received the funds. The preimage alone only proves someone paid some invoice with that hash — not that our wallet got the money. A malicious client could replay a preimage from an unrelated payment.
- **L1**: Stubbed in prototype. Needs block confirmation tracking, out of scope for instant payments.

One facilitator keeps routing simple and matches the single-scheme ("exact") model from x402.

## 3. SparkReadonlyClient for verification

The facilitator uses `SparkReadonlyClient` (not a full wallet) to verify transfers. It only needs to read transfer status, not move funds. This reduces the security surface — the facilitator never holds keys that can spend. If the readonly client proves insufficient for transfer queries at implementation time, we fall back to `SparkReadonlyClient.createWithMasterKey()` which authenticates for reads without exposing spending keys.

## 4. Resource server owns the wallet, facilitator only verifies

The resource server holds the Spark wallet and creates invoices in its 402 response. The facilitator queries the network to confirm payments happened. This separation matches the x402 architecture where the facilitator is a shared service multiple resource servers can use.

## 5. Replay protection and resource binding

The facilitator maintains in-memory state for three concerns:

- **Replay protection**: A `Map<proof, paymentId>` tracks which proof (transfer_id, preimage, txid) was used for which payment request. Same proof reused with a different paymentId is rejected.
- **Resource binding**: The resource server hashes the canonical resource URL into the invoice memo and the `extra.resourceHash` field. Verification confirms the payment's memo matches. This prevents cross-resource reuse — paying for `/weather` can't unlock `/premium-data`.
- **Idempotency**: Both verify and settle cache results by paymentId. Repeated calls return the same response without re-querying.

This means the facilitator is NOT stateless — it holds in-memory maps. For production, these move to Redis or a database with TTL expiry to bound memory growth.

## 6. Lightning verification is not just a hash check

A preimage proving `SHA256(preimage) === payment_hash` is necessary but not sufficient. We also:

1. Parse the BOLT11 invoice to validate amount, expiry, and description.
2. Query the server's wallet for an incoming Lightning transfer matching the payment, confirming funds actually arrived.

Without step 2, a client could submit a preimage from a completely unrelated Lightning payment that happens to match the hash.

## 7. Invoice correlation: amount+address, not invoice ID

The server creates a fresh invoice per 402 response, but verification does NOT require matching a specific invoice ID. Instead, it checks that a valid payment of the correct amount reached the correct address within the timeout window. The `paymentId` (a uuid in `extra`) binds the 402 response to the client's retry — not to a specific invoice. This avoids the freshness problem where rapid requests create multiple invoices and the client's payment can't be correlated back.

## 8. Settle is async from the client's perspective

The resource server calls `/verify`, returns 200 with the resource if valid, and fire-and-forgets the `/settle` call afterward. This removes settle from the critical path — the client gets its response as soon as verification passes. Settle runs in the background to log delivery. This matches the x402 spec's guidance that settlement can be deferred.

## 9. Error handling: never throw through verify

SDK and network errors during verification return a `VerifyResponse` with `isValid: false` and `invalidReason: "upstream_error"`, not HTTP 500s. The facilitator's HTTP layer always returns 200 with a structured response body for verify/settle calls. Only malformed requests (missing fields, bad JSON) return 400. This gives the resource server a consistent interface — it always gets a parseable response and can decide how to handle failures.

## 10. Prototype scoping

What's in:
- Spark direct transfer (primary path, best UX for agent-to-agent)
- Lightning with full verification (preimage + BOLT11 parse + wallet receipt confirmation)
- Replay protection, resource binding, idempotency
- Full 402 → pay → retry → 200 flow

What's deferred:
- L1 deposit confirmation tracking
- Token invoices (BTC-only)
- Persistent state store
- Production key management

## 11. Tech choices

- **Express** — minimal, well-known, no framework overhead.
- **@buildonspark/spark-sdk** — wallet init, invoice creation, transfer queries, Lightning support.
- **light-bolt11-decoder** — BOLT11 invoice parsing for Lightning verification.
- **Separate processes** for facilitator, resource server, and client — mirrors real deployment. These are independent services that communicate over HTTP.
- **Environment variables** for wallet mnemonics — acceptable for prototype, not production.
