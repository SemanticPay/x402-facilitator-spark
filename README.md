# x402-facilitator-spark

An x402 payment server using [Spark](https://spark.money) invoices. Spark is a Bitcoin L2 with instant transfers. This enables machine-to-machine payments over HTTP using the [x402 protocol](https://github.com/coinbase/x402) with Spark as the settlement layer.

## How it works

The x402 protocol uses HTTP status code **402 (Payment Required)** to enable pay-per-request APIs. The flow:

```
Client                     Resource Server
  |                              |
  |--- GET /weather ------------>|
  |<-- 402 + sparkInvoice -------|
  |                              |
  | (pays invoice via Spark)     |
  |                              |
  |--- GET /weather + invoice -->|
  |    (X-PAYMENT header)       |
  |                              |  querySparkInvoices → PAID?
  |<-- 200 + weather data -------|
```

1. **Client** requests a protected resource
2. **Server** responds with 402 and a Spark invoice in the payment requirements
3. **Client** pays the invoice using `wallet.fulfillSparkInvoice()`
4. **Client** retries the request with an `X-PAYMENT` header containing the invoice string as proof
5. **Server** calls `wallet.querySparkInvoices()` to check if the invoice is paid
6. **Server** returns the resource (no separate settle step — Spark payments are instant and final)

There is no separate facilitator process. The server verifies payments directly using its own wallet.

## Components

### Resource Server (`src/server/`)

An API server with a protected `/weather` endpoint. When hit without payment, it returns a 402 response containing a Spark invoice. When hit with a valid `X-PAYMENT` header, it verifies the invoice is paid and returns the weather data.

Replay protection uses an in-memory `Map` with TTL-based eviction matching invoice expiry.

### Client (`src/client/`)

A test script that runs the full payment flow end-to-end:
1. Requests `/weather` and receives the 402
2. Extracts the Spark invoice from the response
3. Pays the invoice via `wallet.fulfillSparkInvoice()`
4. Retries with the invoice string as proof in the `X-PAYMENT` header
5. Prints the resource and payment response

## Project structure

```
x402-facilitator-spark/
├── src/
│   ├── types.ts                       # x402 and Spark-specific type definitions
│   ├── generate-wallets.ts            # Utility to generate Spark wallet mnemonics
│   ├── server/
│   │   └── index.ts                   # Resource server (creates invoices, verifies payment)
│   ├── client/
│   │   └── index.ts                   # Test client (pays invoice and retries)
│   └── test/
│       └── integration.ts             # Integration tests with mocked invoice state
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
SERVER_PORT=4021
RESOURCE_PRICE_SATS=1000
```

### Fund the client wallet

The client wallet needs sats to make payments. On testnet, use the Spark testnet faucet. On mainnet, send BTC to the client's Spark address.

## Running

Start the server and client in separate terminals:

**Terminal 1 — Resource server**
```bash
npm run server
```

**Terminal 2 — Client**
```bash
npm run client
```

The client will:
1. Hit the server and get a 402
2. Pay the Spark invoice
3. Retry with the invoice as proof
4. Print the weather data and payment response

## Testing

```bash
npm test
```

Runs integration tests with mocked invoice state (no Spark network needed).

## x402 Protocol Details

### 402 Response

```json
{
  "x402Version": 1,
  "resource": { "url": "http://localhost:4021/weather" },
  "accepts": [{
    "scheme": "exact",
    "network": "spark",
    "asset": "BTC",
    "amount": "1000",
    "payTo": "spark1...",
    "maxTimeoutSeconds": 60,
    "extra": { "sparkInvoice": "spark1..." }
  }]
}
```

### X-PAYMENT Header

```json
{
  "x402Version": 1,
  "accepted": { "..." : "..." },
  "payload": {
    "paymentType": "SPARK",
    "sparkInvoice": "spark1..."
  }
}
```

### X-PAYMENT-RESPONSE Header

```json
{
  "success": true,
  "network": "spark",
  "sparkInvoice": "spark1..."
}
```

## Security notes

- The server verifies invoices directly — no separate facilitator with network hops
- Replay protection tracks used invoices with TTL eviction matching invoice expiry
- Wallet mnemonics are loaded from environment variables — use proper secret management in production
- In-memory state resets on restart; production deployments need persistent storage (Redis, etc.)

## References

- [x402 protocol](https://github.com/coinbase/x402)
- [Spark documentation](https://docs.spark.money/start/overview)
- [Spark SDK: createSatsInvoice](https://docs.spark.money/api-reference/wallet/create-sats-invoice)
- [Spark SDK: fulfillSparkInvoice](https://docs.spark.money/api-reference/wallet/fulfill-spark-invoice)
- [Spark SDK: querySparkInvoices](https://docs.spark.money/api-reference/wallet/query-spark-invoices)
- [@buildonspark/spark-sdk](https://www.npmjs.com/package/@buildonspark/spark-sdk)
