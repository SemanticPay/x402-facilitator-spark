import "dotenv/config";
import express from "express";
import { SparkExactFacilitator } from "./sparkExactFacilitator.js";
import type { VerifyRequest, SettleRequest } from "../types.js";

const PORT = parseInt(process.env.FACILITATOR_PORT || "4020", 10);
const SPARK_NETWORK = process.env.SPARK_NETWORK || "TESTNET";
const SERVER_MNEMONIC = process.env.SERVER_MNEMONIC;

const app = express();
app.use(express.json());

const facilitator = new SparkExactFacilitator();

app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.post("/verify", async (req, res) => {
  const body = req.body as VerifyRequest;

  if (!body.paymentPayload || !body.paymentRequirements) {
    res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
    return;
  }

  const result = await facilitator.verify(body.paymentPayload, body.paymentRequirements);
  res.json(result);
});

app.post("/settle", async (req, res) => {
  const body = req.body as SettleRequest;

  if (!body.paymentPayload || !body.paymentRequirements) {
    res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
    return;
  }

  const result = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
  res.json(result);
});

async function main() {
  console.log(`Initializing facilitator (network: ${SPARK_NETWORK})...`);

  await facilitator.init({
    network: SPARK_NETWORK,
    mnemonic: SERVER_MNEMONIC,
  });

  app.listen(PORT, () => {
    console.log(`Facilitator running on http://localhost:${PORT}`);
    console.log(`  GET  /supported`);
    console.log(`  POST /verify`);
    console.log(`  POST /settle`);
  });
}

main().catch((err) => {
  console.error("Failed to start facilitator:", err);
  process.exit(1);
});
