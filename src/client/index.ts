import "dotenv/config";
import { SparkWallet } from "@buildonspark/spark-sdk";
import type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  SparkPaymentResponse,
} from "../types.js";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:4021";
const SPARK_NETWORK = process.env.SPARK_NETWORK || "TESTNET";
const CLIENT_MNEMONIC = process.env.CLIENT_MNEMONIC;

if (!CLIENT_MNEMONIC) {
  console.error("CLIENT_MNEMONIC is required");
  process.exit(1);
}

async function main() {
  console.log(`Initializing client wallet (network: ${SPARK_NETWORK})...`);

  const initResult = await SparkWallet.initialize({
    mnemonicOrSeed: CLIENT_MNEMONIC,
    options: { network: SPARK_NETWORK === "MAINNET" ? "MAINNET" : "TESTNET" },
  });
  const wallet = initResult.wallet;
  const clientAddress = await wallet.getSparkAddress();
  console.log(`Client Spark address: ${clientAddress}`);

  // Check balance
  const balance = await wallet.getBalance();
  console.log(`Client balance: ${balance.balance} sats`);

  // Step 1: Request the resource
  console.log(`\nRequesting ${SERVER_URL}/weather...`);
  const initialResp = await fetch(`${SERVER_URL}/weather`);

  if (initialResp.status !== 402) {
    console.log(`Unexpected status: ${initialResp.status}`);
    const body = await initialResp.text();
    console.log(body);
    return;
  }

  console.log("Received 402 Payment Required");
  const paymentRequired: PaymentRequired = await initialResp.json() as PaymentRequired;

  if (!paymentRequired.accepts || paymentRequired.accepts.length === 0) {
    console.error("No payment options in 402 response");
    return;
  }

  const requirements: PaymentRequirements = paymentRequired.accepts[0];
  console.log(`  Scheme: ${requirements.scheme}`);
  console.log(`  Network: ${requirements.network}`);
  console.log(`  Amount: ${requirements.amount} sats`);
  console.log(`  Pay to: ${requirements.payTo}`);
  console.log(`  Payment ID: ${requirements.extra.paymentId}`);

  // Step 2: Pay via Spark
  console.log(`\nPaying ${requirements.amount} sats via Spark...`);

  let transferId: string;
  try {
    // Use fulfillSparkInvoice if we got an invoice back, otherwise direct transfer
    const payTo = requirements.payTo;
    const amount = parseInt(requirements.amount, 10);

    const result = await wallet.transfer({
      receiverSparkAddress: payTo,
      amountSats: amount,
    });

    // The transfer result contains the transfer info
    transferId = result.id;
    console.log(`Payment sent! Transfer ID: ${transferId}`);
  } catch (err) {
    console.error("Payment failed:", err);
    return;
  }

  // Step 3: Retry with X-PAYMENT header
  console.log("\nRetrying request with payment proof...");

  const paymentPayload: PaymentPayload = {
    x402Version: 1,
    resource: paymentRequired.resource,
    accepted: requirements,
    payload: {
      paymentType: "SPARK",
      transfer_id: transferId,
    },
  };

  const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  const retryResp = await fetch(`${SERVER_URL}/weather`, {
    headers: {
      "X-PAYMENT": xPayment,
    },
  });

  console.log(`Response status: ${retryResp.status}`);

  if (retryResp.status === 200) {
    // Decode X-PAYMENT-RESPONSE
    const xPaymentResponse = retryResp.headers.get("x-payment-response");
    if (xPaymentResponse) {
      const decoded: SparkPaymentResponse = JSON.parse(
        Buffer.from(xPaymentResponse, "base64").toString("utf-8"),
      );
      console.log("\nX-PAYMENT-RESPONSE:");
      console.log(`  Success: ${decoded.success}`);
      console.log(`  Network: ${decoded.network}`);
      console.log(`  Payment type: ${decoded.paymentType}`);
      console.log(`  Transfer ID: ${decoded.transfer_id || "N/A"}`);
    }

    const body = await retryResp.json();
    console.log("\nResource content:");
    console.log(JSON.stringify(body, null, 2));
  } else {
    const body = await retryResp.json();
    console.log("Payment verification failed:");
    console.log(JSON.stringify(body, null, 2));
  }

  // Cleanup
  await wallet.cleanupConnections();
}

main().catch((err) => {
  console.error("Client error:", err);
  process.exit(1);
});
