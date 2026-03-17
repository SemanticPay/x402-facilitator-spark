import type { VerifyResponse, SettleResponse } from "../types.js";

export class PaymentStore {
  // proof (transfer_id / preimage / txid) → paymentId that first used it
  private usedProofs = new Map<string, string>();

  // paymentId → cached responses
  private verifyResults = new Map<string, VerifyResponse>();
  private settleResults = new Map<string, SettleResponse>();

  // paymentId → delivery record
  private deliveryLog = new Map<string, { settledAt: number; transaction: string }>();

  // --- Replay protection ---

  hasBeenUsed(proof: string): boolean {
    return this.usedProofs.has(proof);
  }

  getOwningPaymentId(proof: string): string | undefined {
    return this.usedProofs.get(proof);
  }

  markUsed(proof: string, paymentId: string): void {
    this.usedProofs.set(proof, paymentId);
  }

  // --- Verify cache ---

  getCachedVerifyResult(paymentId: string): VerifyResponse | undefined {
    return this.verifyResults.get(paymentId);
  }

  cacheVerifyResult(paymentId: string, result: VerifyResponse): void {
    this.verifyResults.set(paymentId, result);
  }

  // --- Settle cache ---

  getCachedSettleResult(paymentId: string): SettleResponse | undefined {
    return this.settleResults.get(paymentId);
  }

  cacheSettleResult(paymentId: string, result: SettleResponse): void {
    this.settleResults.set(paymentId, result);
  }

  // --- Delivery log ---

  recordDelivery(paymentId: string, transaction: string): void {
    this.deliveryLog.set(paymentId, { settledAt: Date.now(), transaction });
  }

  hasDeliveryRecord(paymentId: string): boolean {
    return this.deliveryLog.has(paymentId);
  }
}
