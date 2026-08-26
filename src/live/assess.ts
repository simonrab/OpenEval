import type { SignedPolicy } from "../policy.js";
import { useCanary } from "./sticky.js";

export type LiveAssessInput = {
  user_id?: string;
  request_id?: string;
};

/** Cached last-known policy in the SDK. Assessment does not fetch. */
export type LiveAssessCache = {
  last_full: SignedPolicy;
  canary: SignedPolicy | null;
  canary_percent: number;
};

/**
 * Live assessment on the request.
 * One memory read, and a hash if canary is on.
 * This is not a vendor call.
 */
export function assessLiveRequest(
  input: LiveAssessInput,
  cache: LiveAssessCache,
): SignedPolicy {
  if (cache.canary && useCanary(input, cache.canary_percent)) {
    return cache.canary;
  }
  return cache.last_full;
}
