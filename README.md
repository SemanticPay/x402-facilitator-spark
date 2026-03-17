# x402-facilitator-spark

An x402 facilitator that supports [Spark](https://spark.money) invoices as a payment scheme. Spark is a Bitcoin L2 with instant transfers. This facilitator enables machine-to-machine payments over HTTP using the [x402 protocol](https://github.com/coinbase/x402) with Spark as the settlement layer.

## How it works

The x402 protocol uses HTTP status code **402 (Payment Required)** to enable pay-per-request APIs. The flow:

```
Client                     Resource Server                Facilitator
  |                              |                              |
  |--- GET /weather ------------>|                              |
  |<-- 402 + payment details ----|                              |
  |                              |                              |
  | (pays Spark invoice)         |                              |
  |                              |                              |
  |--- GET /weather + proof ---->|                              |
  |                              |--- POST /verify + proof ---->|
  |                              |<-- { isValid: true } --------|
  |<-- 200 + weather data -------|                              |
  |                              |--- POST /settle (async) ---->|
  |                              |                              |
```

1. **Client** requests a protected resource
2. **Server** responds with 402 and payment requirements (Spark address, amount, invoice)
3. **Client** pays the Spark invoice using its own wallet
4. **Client** retries the request with an `X-PAYMENT` header containing proof of payment
5. **Server** asks the **Facilitator** to verify the payment
6. **Server** returns the resource and fires off settlement asynchronously

## Components

### Facilitator (`src/facilitator/`)

The payment verification and settlement service. Exposes three endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/supported` | GET | Returns supported payment schemes (`exact` scheme, `spark` network) |
| `/verify` | POST | Verifies a payment proof against requirements (amount, recipient, finality) |
| `/settle` | POST | Acknowledges settlement. For Spark, payments have instant finality so this is a confirmation no-op |

The facilitator uses `SparkReadonlyClient` for verification — it never holds spending keys. It includes replay protection (tracks used proofs) and idempotent caching.

**Supported payment types:**

- **SPARK** — Direct Spark transfer. Verified by looking up the `transfer_id` via the SDK and confirming amount, recipient, and completion status.
- **LIGHTNING** — Lightning Network payment routed through Spark. Verified by checking `SHA256(preimage) === payment_hash` from the BOLT11 invoice, plus confirming receipt on the server wallet.
- **L1** — Bitcoin on-chain deposit. Stubbed in this prototype (needs block confirmation tracking).

### Resource Server (`src/server/`)

A test API server with a protected `/weather` endpoint. When hit without payment, it returns a 402 response containing:
- A Spark invoice (for direct transfers)
- A Lightning invoice (for LN payments)
- The server's Spark address, required amount, and a unique `paymentId`

When hit with a valid `X-PAYMENT` header, it verifies via the facilitator and returns the weather data.

### Client (`src/client/`)

A test script that runs the full payment flow end-to-end:
1. Requests `/weather` and receives the 402
2. Parses payment requirements
3. Sends a Spark transfer to the server's address
4. Constructs the `X-PAYMENT` header with the `transfer_id`
5. Retries the request and prints the resource

## Project structure

```
x402-facilitator-spark/
├── src/
│   ├── types.ts                       # x402 and Spark-specific type definitions
│   ├── generate-wallets.ts            # Utility to generate Spark wallet mnemonics
│   ├── facilitator/
│   │   ├── index.ts                   # Express server (ports /verify, /settle, /supported)
│   │   ├── sparkExactFacilitator.ts   # Core verification and settlement logic
│   │   └── paymentStore.ts            # In-memory replay protection and result caching
│   ├── server/
│   │   └── index.ts                   # Test resource server (issues 402s, creates invoices)
│   └── client/
│       └── index.ts                   # Test client (pays and retries)
├── design.md                          # Design decisions and trade-offs
├── PLAN.md                            # Implementation plan
├── package.json
├── tsconfig.json
└── .env.example
```

## Setup

### Prerequisites

- Node.js 18+
- npm

### Install dependencies

```bash
npm install
```

### Generate wallets

You need two Spark wallets: one for the resource server (receives payments) and one for the client (sends payments).

```bash
npm run generate-wallets
```

This outputs two mnemonics and their Spark addresses. Copy them into your `.env` file.

### Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your wallet mnemonics:

```env
SPARK_NETWORK=TESTNET
SERVER_MNEMONIC=your server mnemonic words here
CLIENT_MNEMONIC=your client mnemonic words here
FACILITATOR_PORT=4020
SERVER_PORT=4021
RESOURCE_PRICE_SATS=1000
FACILITATOR_URL=http://localhost:4020
```

### Fund the client wallet

The client wallet needs sats to make payments. On testnet, use the Spark testnet faucet. On mainnet, send BTC to the client's Spark address.

## Running

Start all three components in separate terminals:

**Terminal 1 — Facilitator**
```bash
npm run facilitator
```

**Terminal 2 — Resource server**
```bash
npm run server
```

**Terminal 3 — Client**
```bash
npm run client
```

The client will:
1. Hit the server and get a 402
2. Pay the required amount via Spark
3. Retry with proof
4. Print the weather data and payment response

## API reference

### `POST /verify`

Verify a payment proof against requirements.

**Request body:**
```json
{
  "x402Version": 1,
  "paymentPayload": {
    "x402Version": 1,
    "resource": { "url": "http://localhost:4021/weather" },
    "accepted": { "scheme": "exact", "network": "spark", "..." : "..." },
    "payload": {
      "paymentType": "SPARK",
      "transfer_id": "abc123"
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "spark",
    "asset": "BTC",
    "amount": "1000",
    "payTo": "sp1...",
    "maxTimeoutSeconds": 60,
    "extra": {
      "paymentId": "uuid",
      "resourceHash": "sha256hex"
    }
  }
}
```

**Response:**
```json
{
  "isValid": true,
  "payer": "sender_public_key_hex"
}
```

Or on failure:
```json
{
  "isValid": false,
  "invalidReason": "transfer_not_found",
  "invalidMessage": "Transfer abc123 not found"
}
```

### `POST /settle`

Acknowledge settlement after verification.

**Request body:** Same shape as `/verify`.

**Response:**
```json
{
  "success": true,
  "payer": "sender_public_key_hex",
  "transaction": "abc123",
  "network": "spark"
}
```

### `GET /supported`

Returns supported payment schemes.

**Response:**
```json
{
  "kinds": [{ "x402Version": 1, "scheme": "exact", "network": "spark" }]
}
```

## Payment types

| Type | Proof field | Verification method |
|------|-------------|-------------------|
| SPARK | `transfer_id` | SDK lookup: confirms transfer exists, is completed, and amount is sufficient |
| LIGHTNING | `preimage` | Cryptographic: `SHA256(preimage) === payment_hash` from BOLT11 invoice, plus wallet receipt check |
| L1 | `txid` | Not implemented in prototype (needs confirmation tracking) |

## Security notes

- The facilitator uses `SparkReadonlyClient` — it cannot spend funds, only read transfer status
- Replay protection tracks used proofs in memory; a given `transfer_id` or `preimage` can only be used once
- Wallet mnemonics are loaded from environment variables — use proper secret management in production
- The in-memory payment store resets on restart; production deployments need persistent storage

## Prototype limitations

- **No persistent state** — replay protection and caching are in-memory only
- **L1 deposits not supported** — would require block confirmation monitoring
- **BTC only** — no token invoice support
- **Single-process stores** — horizontal scaling would need shared state (Redis, etc.)
- **No TLS** — production deployments should use HTTPS between all components

## References

- [x402 protocol](https://github.com/coinbase/x402)
- [x402 facilitator mechanism spec](https://github.com/coinbase/x402/blob/main/go/mechanisms/README.md)
- [Spark exact scheme proposal](https://github.com/google-agentic-commerce/a2a-x402/blob/main/schemes/scheme_exact_spark.md)
- [Spark documentation](https://docs.spark.money/start/overview)
- [@buildonspark/spark-sdk](https://www.npmjs.com/package/@buildonspark/spark-sdk)
