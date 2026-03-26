import { createHash } from "crypto";

// --- Payment types ---

export interface SparkPayloadFields {
  paymentType: "SPARK";
  sparkInvoice: string;
}

export interface SparkPaymentExtra {
  sparkInvoice: string;
}

export interface SparkPaymentResponse {
  success: boolean;
  network: "spark";
  sparkInvoice: string;
}

// --- x402 core types ---

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

// --- Helpers ---

export function computeResourceHash(resourceUrl: string): string {
  return createHash("sha256").update(resourceUrl).digest("hex");
}
