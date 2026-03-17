import "dotenv/config";
import { randomUUID } from "crypto";
import express from "express";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { computeResourceHash } from "../types.js";
import type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  SparkPaymentResponse,
  VerifyRequest,
  SettleRequest,
} from "../types.js";

const PORT = parseInt(process.env.SERVER_PORT || "4021", 10);
const SPARK_NETWORK = process.env.SPARK_NETWORK || "TESTNET";
const SERVER_MNEMONIC = process.env.SERVER_MNEMONIC;
const FACILITATOR_URL = process.env.FACILITATOR_URL || "http://localhost:4020";
const PRICE_SATS = parseInt(process.env.RESOURCE_PRICE_SATS || "1000", 10);

if (!SERVER_MNEMONIC) {
  console.error("SERVER_MNEMONIC is required");
  process.exit(1);
}

const app = express();
app.use(express.json());

let wallet: InstanceType<typeof SparkWallet>;
let sparkAddress: string;

// Protected resource endpoint
app.get("/weather", async (req, res) => {
  const xPayment = req.headers["x-payment"] as string | undefined;

  if (!xPayment) {
    // No payment — return 402 with requirements
    await return402(req, res);
    return;
  }

  // Decode and verify payment
  let paymentPayload: PaymentPayload;
  try {
    const decoded = Buffer.from(xPayment, "base64").toString("utf-8");
    paymentPayload = JSON.parse(decoded);
  } catch {
    res.status(400).json({ error: "Invalid X-PAYMENT header" });
    return;
  }

  // Build the requirements that match what we would have sent
  const resourceUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const resourceHash = computeResourceHash(resourceUrl);
  const paymentRequirements: PaymentRequirements = {
    scheme: "exact",
    network: "spark",
    asset: "BTC",
    amount: String(PRICE_SATS),
    payTo: sparkAddress,
    maxTimeoutSeconds: 60,
    extra: {
      paymentId: paymentPayload.accepted?.extra?.paymentId || "",
      resourceHash,
    },
  };

  // Verify with facilitator
  const verifyBody: VerifyRequest = {
    x402Version: 1,
    paymentPayload,
    paymentRequirements,
  };

  let verifyResult;
  try {
    const verifyResp = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyBody),
    });
    verifyResult = await verifyResp.json();
  } catch (err) {
    res.status(502).json({ error: "Failed to reach facilitator", details: String(err) });
    return;
  }

  if (!verifyResult.isValid) {
    res.status(402).json({
      error: "Payment verification failed",
      reason: verifyResult.invalidReason,
      message: verifyResult.invalidMessage,
    });
    return;
  }

  // Build response
  const payload = paymentPayload.payload;
  const paymentResponse: SparkPaymentResponse = {
    success: true,
    network: "spark",
    paymentType: payload.paymentType,
    transfer_id: payload.transfer_id,
    preimage: payload.preimage,
    txid: payload.txid,
  };

  const xPaymentResponse = Buffer.from(JSON.stringify(paymentResponse)).toString("base64");

  // Return the protected resource
  res.setHeader("X-PAYMENT-RESPONSE", xPaymentResponse);
  res.json({
    temperature: 72,
    unit: "fahrenheit",
    location: "San Francisco",
    conditions: "sunny",
    forecast: "Clear skies ahead",
  });

  // Fire-and-forget settle
  const settleBody: SettleRequest = {
    x402Version: 1,
    paymentPayload,
    paymentRequirements,
  };
  fetch(`${FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settleBody),
  }).catch((err) => {
    console.error("Settle fire-and-forget failed:", err);
  });
});

async function return402(req: express.Request, res: express.Response) {
  const resourceUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const resourceHash = computeResourceHash(resourceUrl);
  const paymentId = randomUUID();

  // Create a Spark invoice
  let sparkInvoice: string | undefined;
  try {
    sparkInvoice = await wallet.createSatsInvoice({
      amount: PRICE_SATS,
      memo: resourceHash,
    });
  } catch (err) {
    console.error("Failed to create Spark invoice:", err);
  }

  // Create a Lightning invoice
  let lightningInvoice: string | undefined;
  try {
    const lnResult = await wallet.createLightningInvoice({
      amountSats: PRICE_SATS,
      memo: resourceHash,
      expirySeconds: 60,
    });
    lightningInvoice = lnResult.invoice.encodedInvoice;
  } catch (err) {
    console.error("Failed to create Lightning invoice:", err);
  }

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: "spark",
    asset: "BTC",
    amount: String(PRICE_SATS),
    payTo: sparkAddress,
    maxTimeoutSeconds: 60,
    extra: {
      paymentId,
      resourceHash,
      lightningInvoice,
    },
  };

  const body: PaymentRequired = {
    x402Version: 1,
    resource: {
      url: resourceUrl,
      description: "Weather data",
      mimeType: "application/json",
    },
    accepts: [requirements],
  };

  res.status(402).json(body);
}

async function main() {
  console.log(`Initializing resource server wallet (network: ${SPARK_NETWORK})...`);

  const initResult = await SparkWallet.initialize({
    mnemonicOrSeed: SERVER_MNEMONIC,
    options: { network: SPARK_NETWORK === "MAINNET" ? "MAINNET" : "TESTNET" },
  });
  wallet = initResult.wallet;
  sparkAddress = await wallet.getSparkAddress();

  console.log(`Server Spark address: ${sparkAddress}`);

  app.listen(PORT, () => {
    console.log(`Resource server running on http://localhost:${PORT}`);
    console.log(`  GET /weather (protected, ${PRICE_SATS} sats)`);
  });
}

main().catch((err) => {
  console.error("Failed to start resource server:", err);
  process.exit(1);
});
