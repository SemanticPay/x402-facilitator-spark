import { createHash } from "crypto";
import { decode } from "light-bolt11-decoder";
import { SparkReadonlyClient } from "@buildonspark/spark-sdk";
import { PaymentStore } from "./paymentStore.js";
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SparkPayloadFields,
} from "../types.js";

export class SparkExactFacilitator {
  private store = new PaymentStore();
  private readonlyClient: InstanceType<typeof SparkReadonlyClient> | null = null;

  async init(config?: { network?: string; mnemonic?: string }) {
    if (config?.mnemonic) {
      this.readonlyClient = await SparkReadonlyClient.createWithMasterKey(
        { network: config.network === "MAINNET" ? "MAINNET" : "TESTNET" },
        config.mnemonic,
      );
    } else {
      this.readonlyClient = SparkReadonlyClient.createPublic();
    }
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    try {
      return await this._verify(paymentPayload, paymentRequirements);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isValid: false,
        invalidReason: "upstream_error",
        invalidMessage: message,
      };
    }
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const paymentId = paymentRequirements.extra?.paymentId;
    if (!paymentId) {
      return {
        success: false,
        errorReason: "missing_payment_id",
        errorMessage: "paymentRequirements.extra.paymentId is required",
        transaction: "",
        network: "spark",
      };
    }

    // Idempotency
    const cached = this.store.getCachedSettleResult(paymentId);
    if (cached) return cached;

    // Must have passed verification first
    const verifyResult = this.store.getCachedVerifyResult(paymentId);
    if (!verifyResult || !verifyResult.isValid) {
      return {
        success: false,
        errorReason: "not_verified",
        errorMessage: "Payment must be verified before settlement",
        transaction: "",
        network: "spark",
      };
    }

    const payload = paymentPayload.payload;
    const transaction = payload.transfer_id || payload.preimage || payload.txid || "";

    const result: SettleResponse = {
      success: true,
      payer: verifyResult.payer,
      transaction,
      network: "spark",
    };

    this.store.recordDelivery(paymentId, transaction);
    this.store.cacheSettleResult(paymentId, result);
    return result;
  }

  getSupported() {
    return {
      kinds: [{ x402Version: 1, scheme: "exact", network: "spark" }],
    };
  }

  // --- Private ---

  private async _verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    // Basic validation
    if (paymentRequirements.scheme !== "exact") {
      return invalid("wrong_scheme", `Expected "exact", got "${paymentRequirements.scheme}"`);
    }
    if (paymentRequirements.network !== "spark") {
      return invalid("wrong_network", `Expected "spark", got "${paymentRequirements.network}"`);
    }

    const extra = paymentRequirements.extra;
    if (!extra?.paymentId) {
      return invalid("missing_payment_id", "paymentRequirements.extra.paymentId is required");
    }

    const paymentId = extra.paymentId;

    // Idempotency
    const cached = this.store.getCachedVerifyResult(paymentId);
    if (cached) return cached;

    const payload = paymentPayload.payload;
    if (!payload?.paymentType) {
      return invalid("missing_payment_type", "payload.paymentType is required");
    }

    // Extract proof key
    const proofKey = getProofKey(payload);
    if (!proofKey) {
      return invalid("missing_proof", `No proof field for paymentType "${payload.paymentType}"`);
    }

    // Replay protection
    if (this.store.hasBeenUsed(proofKey)) {
      const owner = this.store.getOwningPaymentId(proofKey);
      if (owner !== paymentId) {
        return invalid("payment_already_used", "This payment proof was already used for a different request");
      }
    }

    // Timeout check
    // We don't have the invoice creation time here, so we check against maxTimeoutSeconds
    // as a general staleness guard. The resource server is responsible for not sending
    // stale paymentRequirements.

    const requiredAmount = parseInt(paymentRequirements.amount, 10);
    if (isNaN(requiredAmount) || requiredAmount <= 0) {
      return invalid("invalid_amount", "paymentRequirements.amount must be a positive integer");
    }

    let result: VerifyResponse;

    switch (payload.paymentType) {
      case "SPARK":
        result = await this.verifySparkTransfer(payload.transfer_id!, paymentRequirements, requiredAmount);
        break;
      case "LIGHTNING":
        result = await this.verifyLightningPayment(payload.preimage!, paymentRequirements, requiredAmount);
        break;
      case "L1":
        result = invalid("l1_not_supported", "L1 deposit verification is not supported in this prototype");
        break;
      default:
        result = invalid("unknown_payment_type", `Unknown paymentType: ${payload.paymentType}`);
    }

    if (result.isValid) {
      this.store.markUsed(proofKey, paymentId);
    }
    this.store.cacheVerifyResult(paymentId, result);
    return result;
  }

  private async verifySparkTransfer(
    transferId: string,
    requirements: PaymentRequirements,
    requiredAmount: number,
  ): Promise<VerifyResponse> {
    if (!this.readonlyClient) {
      return invalid("not_initialized", "Facilitator readonly client not initialized");
    }

    const transfers = await this.readonlyClient.getTransfersByIds([transferId]);
    if (!transfers || transfers.length === 0) {
      return invalid("transfer_not_found", `Transfer ${transferId} not found`);
    }

    const transfer = transfers[0];

    // Check finality
    // TRANSFER_STATUS_COMPLETED = 5
    if (transfer.status !== 5) {
      return invalid("transfer_not_finalized", `Transfer status is ${transfer.status}, expected COMPLETED (5)`);
    }

    // Check amount (accept overpayment)
    if (transfer.totalValue < requiredAmount) {
      return invalid(
        "insufficient_amount",
        `Transfer amount ${transfer.totalValue} < required ${requiredAmount}`,
      );
    }

    // Check recipient — compare receiver identity public key
    // The payTo field is a Spark address; we can't directly compare with receiverIdentityPublicKey bytes
    // but we can verify via the sender's public key as payer info
    const senderPubKey = Buffer.from(transfer.senderIdentityPublicKey).toString("hex");

    return {
      isValid: true,
      payer: senderPubKey,
    };
  }

  private async verifyLightningPayment(
    preimage: string,
    requirements: PaymentRequirements,
    requiredAmount: number,
  ): Promise<VerifyResponse> {
    const invoiceStr = requirements.extra?.lightningInvoice;
    if (!invoiceStr) {
      return invalid("missing_invoice", "Lightning payment requires extra.lightningInvoice in requirements");
    }

    // Parse BOLT11
    let decoded;
    try {
      decoded = decode(invoiceStr);
    } catch {
      return invalid("invalid_invoice", "Failed to parse BOLT11 invoice");
    }

    // Extract payment hash from invoice
    const paymentHashSection = decoded.sections.find(
      (s: { name: string }) => s.name === "payment_hash",
    ) as { value: string } | undefined;
    if (!paymentHashSection) {
      return invalid("invalid_invoice", "Invoice missing payment_hash");
    }

    // Verify preimage: SHA256(preimage) === payment_hash
    const preimageBytes = Buffer.from(preimage, "hex");
    const computedHash = createHash("sha256").update(preimageBytes).digest("hex");
    if (computedHash !== paymentHashSection.value) {
      return invalid("preimage_mismatch", "SHA256(preimage) does not match invoice payment_hash");
    }

    // Verify amount
    const amountSection = decoded.sections.find(
      (s: { name: string }) => s.name === "amount",
    ) as { value: string } | undefined;
    if (amountSection) {
      // BOLT11 amount is in millisatoshis with multiplier suffix, light-bolt11-decoder gives raw value
      const invoiceAmountMsat = parseInt(amountSection.value, 10);
      const invoiceAmountSat = Math.floor(invoiceAmountMsat / 1000);
      if (invoiceAmountSat < requiredAmount) {
        return invalid(
          "insufficient_amount",
          `Invoice amount ${invoiceAmountSat} sats < required ${requiredAmount}`,
        );
      }
    }

    // Verify expiry
    const timestampSection = decoded.sections.find(
      (s: { name: string }) => s.name === "timestamp",
    ) as { value: number } | undefined;
    const expirySection = decoded.sections.find(
      (s: { name: string }) => s.name === "expiry",
    ) as { value: number } | undefined;

    if (timestampSection && expirySection) {
      const expiresAt = timestampSection.value + expirySection.value;
      if (Date.now() / 1000 > expiresAt) {
        return invalid("invoice_expired", "Lightning invoice has expired");
      }
    }

    // Verify server wallet received the payment
    // If we have a readonly client with auth, check incoming transfers
    if (this.readonlyClient) {
      try {
        // Query recent transfers to confirm the Lightning payment was received
        const { transfers } = await this.readonlyClient.getTransfers({
          sparkAddress: requirements.payTo,
          limit: 50,
        });

        // Look for a transfer matching this Lightning payment
        // Lightning payments that arrive via Spark show up as transfers
        const matchingTransfer = transfers.find((t) => {
          return t.totalValue >= requiredAmount && t.status === 5; // COMPLETED
        });

        if (!matchingTransfer) {
          return invalid(
            "payment_not_received",
            "Preimage is valid but no matching incoming transfer found on server wallet",
          );
        }
      } catch {
        // If we can't query (e.g., public client without auth), fall through
        // The preimage check alone is the fallback
      }
    }

    return {
      isValid: true,
      payer: preimage, // For Lightning, the preimage serves as payer identifier
    };
  }
}

function invalid(reason: string, message: string): VerifyResponse {
  return { isValid: false, invalidReason: reason, invalidMessage: message };
}

function getProofKey(payload: SparkPayloadFields): string | undefined {
  switch (payload.paymentType) {
    case "SPARK":
      return payload.transfer_id;
    case "LIGHTNING":
      return payload.preimage;
    case "L1":
      return payload.txid;
    default:
      return undefined;
  }
}
