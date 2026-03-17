import { createHash } from "crypto";

// --- Payment types matching the scheme spec ---

export type SparkPaymentType = "SPARK" | "LIGHTNING" | "L1";

export interface SparkPayloadFields {
  paymentType: SparkPaymentType;
  transfer_id?: string;
  preimage?: string;
  txid?: string;
}

export interface SparkPaymentExtra {
  lightningInvoice?: string;
  depositAddress?: string;
  paymentId: string;
  resourceHash: string;
}

export interface SparkPaymentResponse {
  success: boolean;
  network: "spark";
  paymentType: SparkPaymentType;
  transfer_id?: string;
  preimage?: string;
  txid?: string;
}

// --- x402 core types (aligned with @coinbase/x402 but standalone) ---

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: SparkPaymentExtra;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: SparkPayloadFields;
}

export interface VerifyRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
}

export interface SettleRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: string;
}

// --- Helpers ---

export function computeResourceHash(resourceUrl: string): string {
  return createHash("sha256").update(resourceUrl).digest("hex");
}

export function extractProofKey(payload: SparkPayloadFields): string | undefined {
  switch (payload.paymentType) {
    case "SPARK":
      return payload.transfer_id;
    case "LIGHTNING":
      return payload.preimage;
    case "L1":
      return payload.txid;
  }
}
