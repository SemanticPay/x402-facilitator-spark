# Design Decisions: x402 Spark Payment Server

## 1. No facilitator process

The facilitator pattern comes from ERC-3009 where someone must submit a signed authorization on-chain. Spark payments are instant and final — by the time the client sends proof, the money has already moved. There's nothing to "settle." The server verifies invoices directly using `wallet.querySparkInvoices()`, eliminating a network hop and a potential point of failure.

## 2. Invoice-based verification

The server creates a Spark invoice per request. The invoice string is both the payment identifier and the proof. The client pays the invoice and sends it back. The server checks if it's PAID. This gives cryptographic binding between the payment and the specific request — unlike raw transfers where any transfer to the address could be presented as proof.

## 3. No L1, no Lightning

L1 was dead code (immediately returned "not supported"). Lightning verification was broken — it matched any completed transfer with sufficient amount in the last 50 transfers, regardless of which invoice it was for. Both were removed. If Lightning is needed, it should be built properly with correct invoice-to-payment binding.

## 4. Replay protection with TTL

Used invoices are tracked in a `Map<string, number>` where the value is an expiry timestamp. After an invoice expires, it can't be paid, so there's no reason to keep tracking it. A periodic eviction sweep clears expired entries. This bounds memory growth, unlike the previous `PaymentStore` which grew unbounded.

## 5. Client uses fulfillSparkInvoice, not transfer

The client pays the specific invoice from the 402 response using `wallet.fulfillSparkInvoice()`. This binds the payment to the request. The previous `wallet.transfer()` approach had no binding — any transfer to the address could be claimed as proof.

## 6. Tech choices

- **Express** — minimal, well-known.
- **@buildonspark/spark-sdk** — wallet init, invoice creation, invoice queries, invoice fulfillment.
- **Single server process** — no facilitator, no inter-service HTTP calls.
- **Environment variables** for wallet mnemonics — acceptable for prototype.
