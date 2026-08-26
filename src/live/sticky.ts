import { createHash } from "node:crypto";

/** First-version canary fraction. Integer 5. Never default a missing percent to 50. */
export const CANARY_PERCENT = 5;

/**
 * Sticky canary bucket.
 * Hash = SHA-256 of the sticky id.
 * Bucket = first 4 bytes as an unsigned big-endian integer, modulo 100.
 * Canary when bucket < 5.
 */
export function stickyBucket(id: string): number {
  const digest = createHash("sha256").update(id, "utf8").digest();
  return digest.readUInt32BE(0) % 100;
}

export function stickyId(input: {
  user_id?: string;
  request_id?: string;
}): string | null {
  if (typeof input.user_id === "string" && input.user_id.length > 0) {
    return input.user_id;
  }
  if (typeof input.request_id === "string" && input.request_id.length > 0) {
    return input.request_id;
  }
  return null;
}

/** Integer 5 is the only valid canary percent. Any other value is last full. */
export function parseCanaryPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return 0;
  }
  if (value !== CANARY_PERCENT) {
    return 0;
  }
  return CANARY_PERCENT;
}

export function useCanary(
  input: { user_id?: string; request_id?: string },
  percent: number,
): boolean {
  if (percent !== CANARY_PERCENT) {
    return false;
  }
  const id = stickyId(input);
  if (id === null) {
    return false;
  }
  return stickyBucket(id) < CANARY_PERCENT;
}
