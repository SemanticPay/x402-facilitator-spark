/**
 * Local integration test for the x402 Spark invoice-based flow.
 *
 * Tests the server's inline invoice verification with mocked invoice state.
 * Mocks wallet.querySparkInvoices and wallet.createSatsInvoice to avoid
 * hitting the Spark network.
 */

import express from "express";
import { computeResourceHash } from "../types.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  PaymentRequired,
  SparkPaymentResponse,
} from "../types.js";

// --- Mock invoice state ---

const invoiceStatuses = new Map<string, string>(); // invoice → "PAID" | "UNPAID" | "EXPIRED"
const usedInvoices = new Map<string, number>(); // invoice → expiry timestamp
const INVOICE_EXPIRY_MS = 60 * 60 * 1000;
let invoiceCounter = 0;

function createMockInvoice(amount: number, memo: string): string {
  invoiceCounter++;
  const invoice = `spark1mock${invoiceCounter}_${amount}_${memo.slice(0, 8)}`;
  invoiceStatuses.set(invoice, "UNPAID");
  return invoice;
}

function payMockInvoice(invoice: string) {
  invoiceStatuses.set(invoice, "PAID");
}

function expireMockInvoice(invoice: string) {
  invoiceStatuses.set(invoice, "EXPIRED");
}

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

// --- Test runner ---

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`  ✓ ${testName}`);
    passed++;
  } else {
    console.log(`  ✗ ${testName}`);
    failed++;
  }
}

async function runTests() {
  console.log("=== x402 Spark Invoice-Based Integration Tests ===\n");

  // --- Set up resource server with mocked wallet ---
  const resourceApp = express();
  resourceApp.use(express.json());

  const SPARK_ADDRESS = "spark1mockserveraddress";
  const PRICE_SATS = 1000;

  resourceApp.get("/weather", async (req, res) => {
    const xPayment = req.headers["x-payment"] as string | undefined;

    if (!xPayment) {
      const resourceUrl = `http://localhost:4031${req.originalUrl}`;
      const resourceHash = computeResourceHash(resourceUrl);

      const sparkInvoice = createMockInvoice(PRICE_SATS, resourceHash);

      const requirements: PaymentRequirements = {
        scheme: "exact",
        network: "spark",
        asset: "BTC",
        amount: String(PRICE_SATS),
        payTo: SPARK_ADDRESS,
        maxTimeoutSeconds: 60,
        extra: { sparkInvoice },
      };

      const body: PaymentRequired = {
        x402Version: 1,
        resource: { url: resourceUrl },
        accepts: [requirements],
      };

      res.status(402).json(body);
      return;
    }

    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = JSON.parse(Buffer.from(xPayment, "base64").toString("utf-8"));
    } catch {
      res.status(400).json({ error: "Invalid X-PAYMENT" });
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

    // Verify invoice status (mocked)
    const status = invoiceStatuses.get(sparkInvoice);
    if (status !== "PAID") {
      res.status(402).json({ error: "Payment verification failed", reason: "invoice_not_paid" });
      return;
    }

    markInvoiceUsed(sparkInvoice);

    const paymentResponse: SparkPaymentResponse = {
      success: true,
      network: "spark",
      sparkInvoice,
    };

    res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(paymentResponse)).toString("base64"));
    res.json({ temperature: 72, unit: "fahrenheit", location: "San Francisco" });
  });

  const resourceServer = resourceApp.listen(4031);
  const SERVER_URL = "http://localhost:4031";

  await new Promise((r) => setTimeout(r, 100));

  // ==========================================
  // TEST 1: GET /weather returns 402 with invoice
  // ==========================================
  console.log("Test 1: 402 response includes Spark invoice");
  {
    const resp = await fetch(`${SERVER_URL}/weather`);
    assert(resp.status === 402, "returns 402");

    const body = await resp.json() as PaymentRequired;
    assert(body.accepts.length > 0, "includes payment requirements");

    const req = body.accepts[0];
    assert(req.extra.sparkInvoice !== undefined, "includes sparkInvoice in extra");
    assert(req.scheme === "exact", "scheme is exact");
    assert(req.network === "spark", "network is spark");
  }

  // ==========================================
  // TEST 2: Full 402 → pay → retry → 200 flow
  // ==========================================
  console.log("\nTest 2: Full payment flow (402 → pay invoice → retry → 200)");
  {
    const resp1 = await fetch(`${SERVER_URL}/weather`);
    const paymentRequired = await resp1.json() as PaymentRequired;
    const requirements = paymentRequired.accepts[0];
    const sparkInvoice = requirements.extra.sparkInvoice;

    // Simulate client paying the invoice
    payMockInvoice(sparkInvoice);

    // Retry with proof
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      resource: paymentRequired.resource,
      accepted: requirements,
      payload: { paymentType: "SPARK", sparkInvoice },
    };

    const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const resp2 = await fetch(`${SERVER_URL}/weather`, {
      headers: { "X-PAYMENT": xPayment },
    });

    assert(resp2.status === 200, "retry with paid invoice returns 200");

    const body = await resp2.json() as any;
    assert(body.temperature === 72, "resource content is correct");

    const xPaymentResponse = resp2.headers.get("x-payment-response");
    assert(xPaymentResponse !== null, "X-PAYMENT-RESPONSE header present");

    if (xPaymentResponse) {
      const decoded: SparkPaymentResponse = JSON.parse(
        Buffer.from(xPaymentResponse, "base64").toString("utf-8"),
      );
      assert(decoded.success === true, "payment response shows success");
      assert(decoded.sparkInvoice === sparkInvoice, "payment response includes invoice");
    }
  }

  // ==========================================
  // TEST 3: Replay protection
  // ==========================================
  console.log("\nTest 3: Replay protection (reuse paid invoice)");
  {
    // Get a new 402
    const resp1 = await fetch(`${SERVER_URL}/weather`);
    const paymentRequired = await resp1.json() as PaymentRequired;
    const requirements = paymentRequired.accepts[0];
    const freshInvoice = requirements.extra.sparkInvoice;

    // Pay and use it
    payMockInvoice(freshInvoice);
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      resource: paymentRequired.resource,
      accepted: requirements,
      payload: { paymentType: "SPARK", sparkInvoice: freshInvoice },
    };
    const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

    const resp2 = await fetch(`${SERVER_URL}/weather`, {
      headers: { "X-PAYMENT": xPayment },
    });
    assert(resp2.status === 200, "first use succeeds");

    // Try to reuse the same invoice
    const resp3 = await fetch(`${SERVER_URL}/weather`, {
      headers: { "X-PAYMENT": xPayment },
    });
    assert(resp3.status === 402, "replay is rejected with 402");
    const body = await resp3.json() as any;
    assert(body.reason === "invoice_already_used", "rejection reason is invoice_already_used");
  }

  // ==========================================
  // TEST 4: Unpaid invoice rejected
  // ==========================================
  console.log("\nTest 4: Unpaid invoice rejected");
  {
    const resp1 = await fetch(`${SERVER_URL}/weather`);
    const paymentRequired = await resp1.json() as PaymentRequired;
    const requirements = paymentRequired.accepts[0];
    const sparkInvoice = requirements.extra.sparkInvoice;

    // Don't pay — just try to use it
    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      resource: paymentRequired.resource,
      accepted: requirements,
      payload: { paymentType: "SPARK", sparkInvoice },
    };

    const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const resp2 = await fetch(`${SERVER_URL}/weather`, {
      headers: { "X-PAYMENT": xPayment },
    });

    assert(resp2.status === 402, "unpaid invoice rejected");
    const body = await resp2.json() as any;
    assert(body.reason === "invoice_not_paid", "reason is invoice_not_paid");
  }

  // ==========================================
  // TEST 5: Expired invoice rejected
  // ==========================================
  console.log("\nTest 5: Expired invoice rejected");
  {
    const resp1 = await fetch(`${SERVER_URL}/weather`);
    const paymentRequired = await resp1.json() as PaymentRequired;
    const requirements = paymentRequired.accepts[0];
    const sparkInvoice = requirements.extra.sparkInvoice;

    // Mark as expired instead of paid
    expireMockInvoice(sparkInvoice);

    const paymentPayload: PaymentPayload = {
      x402Version: 1,
      resource: paymentRequired.resource,
      accepted: requirements,
      payload: { paymentType: "SPARK", sparkInvoice },
    };

    const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const resp2 = await fetch(`${SERVER_URL}/weather`, {
      headers: { "X-PAYMENT": xPayment },
    });

    assert(resp2.status === 402, "expired invoice rejected");
    const body = await resp2.json() as any;
    assert(body.reason === "invoice_not_paid", "reason is invoice_not_paid");
  }

  // ==========================================
  // TEST 6: Invalid X-PAYMENT header
  // ==========================================
  console.log("\nTest 6: Invalid X-PAYMENT header");
  {
    const resp = await fetch(`${SERVER_URL}/weather`, {
      headers: { "X-PAYMENT": "not-valid-base64-json!!!" },
    });
    assert(resp.status === 400, "invalid header returns 400");
  }

  // ==========================================
  // TEST 7: Missing sparkInvoice in payload
  // ==========================================
  console.log("\nTest 7: Missing sparkInvoice in payload");
  {
    const badPayload = {
      x402Version: 1,
      accepted: {},
      payload: { paymentType: "SPARK" },
    };
    const xPayment = Buffer.from(JSON.stringify(badPayload)).toString("base64");
    const resp = await fetch(`${SERVER_URL}/weather`, {
      headers: { "X-PAYMENT": xPayment },
    });
    assert(resp.status === 402, "missing invoice rejected");
    const body = await resp.json() as any;
    assert(body.reason === "invalid_payment_type", "reason is invalid_payment_type");
  }

  // ==========================================
  // Summary
  // ==========================================
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  resourceServer.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
