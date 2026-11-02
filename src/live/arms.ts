import type Database from "better-sqlite3";

/**
 * Live evidence for one policy (one "arm") over a short period.
 * The SDK sends the change since its last report, so rows add up across
 * many app servers.
 */
export type ArmDelta = {
  policy_id: string;
  request_count: number;
  /** Requests that the primary failed and a backup served. */
  fallback_count: number;
  /** Requests where no model gave an answer. */
  error_count: number;
  /** App-reported misses whose sample was held back by the PII check. */
  pii_blocked_miss_count: number;
  latency_ms_sum: number;
  latency_count: number;
  /** Only provider-reported cost. Estimates are left out. */
  cost_usd_sum: number;
  cost_count: number;
  /** Answers that ran through live checks. */
  quality_checked: number;
  /** Answers that failed one or more live checks. */
  quality_failed: number;
};

export function emptyArm(policyId: string): ArmDelta {
  return {
    policy_id: policyId,
    request_count: 0,
    fallback_count: 0,
    error_count: 0,
    pii_blocked_miss_count: 0,
    latency_ms_sum: 0,
    latency_count: 0,
    cost_usd_sum: 0,
    cost_count: 0,
    quality_checked: 0,
    quality_failed: 0,
  };
}

/** Adds b into a. */
export function addArm(a: ArmDelta, b: ArmDelta): void {
  a.request_count += b.request_count;
  a.fallback_count += b.fallback_count;
  a.error_count += b.error_count;
  a.pii_blocked_miss_count += b.pii_blocked_miss_count;
  a.latency_ms_sum += b.latency_ms_sum;
  a.latency_count += b.latency_count;
  a.cost_usd_sum += b.cost_usd_sum;
  a.cost_count += b.cost_count;
  a.quality_checked += b.quality_checked;
  a.quality_failed += b.quality_failed;
}

export function armHasData(arm: ArmDelta): boolean {
  return (
    arm.request_count > 0 ||
    arm.pii_blocked_miss_count > 0 ||
    arm.quality_checked > 0
  );
}

export function recordArmEvent(
  db: Database.Database,
  projectId: string,
  arm: ArmDelta,
  capturedAt: string = new Date().toISOString(),
): void {
  db.prepare(
    `INSERT INTO runtime_arm_events (
       project_id, policy_id, request_count, fallback_count, error_count,
       pii_blocked_miss_count, latency_ms_sum, latency_count,
       cost_usd_sum, cost_count, quality_checked, quality_failed, captured_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectId,
    arm.policy_id,
    arm.request_count,
    arm.fallback_count,
    arm.error_count,
    arm.pii_blocked_miss_count,
    arm.latency_ms_sum,
    arm.latency_count,
    arm.cost_usd_sum,
    arm.cost_count,
    arm.quality_checked,
    arm.quality_failed,
    capturedAt,
  );
}

/** Rates for one policy in a window. null means no data for that rate. */
export type ArmStats = {
  policy_id: string;
  since: string;
  request_count: number;
  fallback_count: number;
  error_count: number;
  miss_count: number;
  quality_checked: number;
  quality_failed: number;
  latency_count: number;
  cost_count: number;
  fallback_rate: number | null;
  error_rate: number | null;
  miss_rate: number | null;
  quality_fail_rate: number | null;
  avg_latency_ms: number | null;
  avg_cost_usd: number | null;
};

/**
 * Sums live evidence for one policy since a time.
 * Misses are app-reported samples for the policy plus misses held back by PII.
 */
export function armStats(
  db: Database.Database,
  projectId: string,
  policyId: string,
  since: string,
): ArmStats {
  const sum = db
    .prepare(
      `SELECT COALESCE(SUM(request_count), 0) AS request_count,
              COALESCE(SUM(fallback_count), 0) AS fallback_count,
              COALESCE(SUM(error_count), 0) AS error_count,
              COALESCE(SUM(pii_blocked_miss_count), 0) AS pii_blocked_miss_count,
              COALESCE(SUM(latency_ms_sum), 0) AS latency_ms_sum,
              COALESCE(SUM(latency_count), 0) AS latency_count,
              COALESCE(SUM(cost_usd_sum), 0) AS cost_usd_sum,
              COALESCE(SUM(cost_count), 0) AS cost_count,
              COALESCE(SUM(quality_checked), 0) AS quality_checked,
              COALESCE(SUM(quality_failed), 0) AS quality_failed
       FROM runtime_arm_events
       WHERE project_id = ? AND policy_id = ? AND captured_at >= ?`,
    )
    .get(projectId, policyId, since) as Omit<ArmDelta, "policy_id">;
  const sampled = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM samples
       WHERE project_id = ? AND policy_id = ? AND why = 'app_reported'
         AND dropped_at IS NULL AND created_at >= ?`,
    )
    .get(projectId, policyId, since) as { n: number };
  const missCount = sampled.n + sum.pii_blocked_miss_count;
  const rate = (k: number, n: number): number | null => (n > 0 ? k / n : null);
  return {
    policy_id: policyId,
    since,
    request_count: sum.request_count,
    fallback_count: sum.fallback_count,
    error_count: sum.error_count,
    miss_count: missCount,
    quality_checked: sum.quality_checked,
    quality_failed: sum.quality_failed,
    latency_count: sum.latency_count,
    cost_count: sum.cost_count,
    fallback_rate: rate(sum.fallback_count, sum.request_count),
    error_rate: rate(sum.error_count, sum.request_count),
    miss_rate: rate(missCount, sum.request_count),
    quality_fail_rate: rate(sum.quality_failed, sum.quality_checked),
    avg_latency_ms: rate(sum.latency_ms_sum, sum.latency_count),
    avg_cost_usd: rate(sum.cost_usd_sum, sum.cost_count),
  };
}

/** Guard limits used to judge a canary against the current full policy. */
export type ArmLimits = {
  max_fallback_rate: number;
  max_error_rate: number;
  max_miss_rate: number;
  max_quality_fail_rate: number;
  /** Most a rate may rise over the full policy's rate (absolute, 0.02 = 2 points). */
  max_rate_increase: number;
  /** Most average latency may rise over the full policy (0.5 = 50 percent). */
  max_latency_increase: number;
  /** Most average cost may rise over the full policy (0.5 = 50 percent). */
  max_cost_increase: number;
  /** Fewest canary requests (or checked answers) before a rate can trigger a rollback. */
  min_rollback_requests: number;
};

/**
 * True when rate a is higher than rate b by more than the margin and the gap
 * is clear at 95 percent (two-proportion z-test). Small samples do not trip it.
 */
export function clearlyHigher(
  kA: number,
  nA: number,
  kB: number,
  nB: number,
  margin: number,
): boolean {
  if (nA === 0 || nB === 0) {
    return false;
  }
  const pA = kA / nA;
  const pB = kB / nB;
  if (pA - pB <= margin) {
    return false;
  }
  const pooled = (kA + kB) / (nA + nB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) {
    return true;
  }
  return (pA - pB) / se > 1.96;
}

/**
 * The first reason the canary looks unhealthy, or null.
 * Every check waits until the canary has min_rollback_requests of traffic.
 * Comparisons with the full policy also need data on the full policy.
 */
export function canaryHealthReason(
  canary: ArmStats,
  control: ArmStats | null,
  limits: ArmLimits,
): string | null {
  const enough = canary.request_count >= limits.min_rollback_requests;
  const enoughChecked = canary.quality_checked >= limits.min_rollback_requests;
  const ctl = control && control.request_count > 0 ? control : null;

  if (enough && (canary.error_rate ?? 0) > limits.max_error_rate) {
    return "error_rate_high";
  }
  if (enough && (canary.fallback_rate ?? 0) > limits.max_fallback_rate) {
    return "fallback_rate_high";
  }
  if (enough && (canary.miss_rate ?? 0) > limits.max_miss_rate) {
    return "miss_rate_high";
  }
  if (enoughChecked && (canary.quality_fail_rate ?? 0) > limits.max_quality_fail_rate) {
    return "quality_fail_rate_high";
  }
  // The z-test is rough on small samples, so comparisons also wait for
  // enough canary traffic.
  if (ctl && enough) {
    const m = limits.max_rate_increase;
    if (clearlyHigher(canary.error_count, canary.request_count, ctl.error_count, ctl.request_count, m)) {
      return "error_rate_worse";
    }
    if (clearlyHigher(canary.fallback_count, canary.request_count, ctl.fallback_count, ctl.request_count, m)) {
      return "fallback_rate_worse";
    }
    if (clearlyHigher(canary.miss_count, canary.request_count, ctl.miss_count, ctl.request_count, m)) {
      return "miss_rate_worse";
    }
  }
  if (control && control.quality_checked > 0 && enoughChecked) {
    if (
      clearlyHigher(
        canary.quality_failed,
        canary.quality_checked,
        control.quality_failed,
        control.quality_checked,
        limits.max_rate_increase,
      )
    ) {
      return "quality_worse";
    }
  }
  if (
    control &&
    canary.latency_count >= limits.min_rollback_requests &&
    control.latency_count >= limits.min_rollback_requests &&
    canary.avg_latency_ms !== null &&
    control.avg_latency_ms !== null &&
    control.avg_latency_ms > 0 &&
    canary.avg_latency_ms > control.avg_latency_ms * (1 + limits.max_latency_increase)
  ) {
    return "latency_worse";
  }
  if (
    control &&
    canary.cost_count >= limits.min_rollback_requests &&
    control.cost_count >= limits.min_rollback_requests &&
    canary.avg_cost_usd !== null &&
    control.avg_cost_usd !== null &&
    control.avg_cost_usd > 0 &&
    canary.avg_cost_usd > control.avg_cost_usd * (1 + limits.max_cost_increase)
  ) {
    return "cost_worse";
  }
  return null;
}
