import "dotenv/config";
import express from "express";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { computeResourceHash } from "../types.js";
import type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  SparkPaymentResponse,
} from "../types.js";

const PORT = parseInt(process.env.SERVER_PORT || "4021", 10);
const SPARK_NETWORK = process.env.SPARK_NETWORK || "TESTNET";
const SERVER_MNEMONIC = process.env.SERVER_MNEMONIC;
const PRICE_SATS = parseInt(process.env.RESOURCE_PRICE_SATS || "1000", 10);
const INVOICE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

if (!SERVER_MNEMONIC) {
  console.error("SERVER_MNEMONIC is required");
  process.exit(1);
}

const app = express();
app.use(express.json());

let wallet: InstanceType<typeof SparkWallet>;
let sparkAddress: string;

// Replay protection with TTL eviction
const usedInvoices = new Map<string, number>(); // invoice → expiry timestamp

function markInvoiceUsed(invoice: string) {
  usedInvoices.set(invoice, Date.now() + INVOICE_EXPIRY_MS);
}

function isInvoiceUsed(invoice: string): boolean {
  const expiry = usedInvoices.get(invoice);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    usedInvoices.delete(invoice);
    return false;
  }
  return true;
}

function evictExpiredInvoices() {
  const now = Date.now();
  for (const [invoice, expiry] of usedInvoices) {
    if (now > expiry) usedInvoices.delete(invoice);
  }
}

// Evict expired invoices every 10 minutes
setInterval(evictExpiredInvoices, 10 * 60 * 1000);

// Protected resource endpoint
app.get("/weather", async (req, res) => {
  const xPayment = req.headers["x-payment"] as string | undefined;

  if (!xPayment) {
    await return402(req, res);
    return;
  }

  // Decode payment
  let paymentPayload: PaymentPayload;
  try {
    const decoded = Buffer.from(xPayment, "base64").toString("utf-8");
    paymentPayload = JSON.parse(decoded);
  } catch {
    res.status(400).json({ error: "Invalid X-PAYMENT header" });
    return;
  }

  const payload = paymentPayload.payload;
  if (payload.paymentType !== "SPARK" || !payload.sparkInvoice) {
    res.status(402).json({ error: "Payment verification failed", reason: "invalid_payment_type" });
    return;
  }

  const sparkInvoice = payload.sparkInvoice;

  // Replay protection
  if (isInvoiceUsed(sparkInvoice)) {
    res.status(402).json({ error: "Payment verification failed", reason: "invoice_already_used" });
    return;
  }

  // Verify invoice is paid
  try {
    const results = await wallet.querySparkInvoices([sparkInvoice]);
    const status = (results as any)[sparkInvoice];
    if (status !== "PAID") {
      res.status(402).json({ error: "Payment verification failed", reason: "invoice_not_paid" });
      return;
    }
  } catch (err) {
    res.status(502).json({ error: "Failed to verify invoice", details: String(err) });
    return;
  }

  markInvoiceUsed(sparkInvoice);

  // Build response
  const paymentResponse: SparkPaymentResponse = {
    success: true,
    network: "spark",
    sparkInvoice,
  };

  const xPaymentResponse = Buffer.from(JSON.stringify(paymentResponse)).toString("base64");

  res.setHeader("X-PAYMENT-RESPONSE", xPaymentResponse);
  res.json({
    temperature: 72,
    unit: "fahrenheit",
    location: "San Francisco",
    conditions: "sunny",
    forecast: "Clear skies ahead",
  });
});

async function return402(req: express.Request, res: express.Response) {
  const resourceUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const resourceHash = computeResourceHash(resourceUrl);

  let sparkInvoice: string;
  try {
    sparkInvoice = await wallet.createSatsInvoice({
      amount: PRICE_SATS,
      memo: resourceHash,
    });
  } catch (err) {
    console.error("Failed to create Spark invoice:", err);
    res.status(500).json({ error: "Failed to create invoice" });
    return;
  }

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: "spark",
    asset: "BTC",
    amount: String(PRICE_SATS),
    payTo: sparkAddress,
    maxTimeoutSeconds: 60,
    extra: {
      sparkInvoice,
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
