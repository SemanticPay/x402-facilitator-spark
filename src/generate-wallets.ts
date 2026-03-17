import { SparkWallet } from "@buildonspark/spark-sdk";

async function main() {
  console.log("Generating server wallet (MAINNET)...");
  const server = await SparkWallet.initialize({
    options: { network: "MAINNET" },
  });
  const serverAddr = await server.wallet.getSparkAddress();
  console.log(`SERVER_MNEMONIC=${server.mnemonic}`);
  console.log(`Server address: ${serverAddr}`);
  await server.wallet.cleanupConnections();

  console.log("\nGenerating client wallet (MAINNET)...");
  const client = await SparkWallet.initialize({
    options: { network: "MAINNET" },
  });
  const clientAddr = await client.wallet.getSparkAddress();
  console.log(`CLIENT_MNEMONIC=${client.mnemonic}`);
  console.log(`Client address: ${clientAddr}`);
  await client.wallet.cleanupConnections();

  console.log("\n--- Paste these into .env ---");
  console.log(`SPARK_NETWORK=MAINNET`);
  console.log(`SERVER_MNEMONIC=${server.mnemonic}`);
  console.log(`CLIENT_MNEMONIC=${client.mnemonic}`);
}

main().catch(console.error);
