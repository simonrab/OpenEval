export type Verdict =
  | "keep"
  | "revert_overfit"
  | "revert_regressed"
  | "within_noise"
  | "not_comparable";

export type Objective = "quality" | "cost";

/** Scored reps for one eval and one candidate. */
export type EvalTally = { k: number; n: number };

export type SplitComparison = {
  n_evals: number;
  baseline_pass_rate: number;
  candidate_pass_rate: number;
  /** Mean of per-eval (candidate - baseline) pass rate. */
  delta: number;
  ci95: [number, number];
  /** Half-width of ci95. */
  noise_floor: number;
  /** Evals the baseline passed on every rep and the candidate failed on every rep. */
  n_regressed: number;
  n_flaky: { baseline: number; candidate: number };
  n_error: { baseline: number; candidate: number };
};

/** Cheaper by less than this fraction counts as noise. */
export const COST_NOISE_FRACTION = 0.02;

const Z95 = 1.96;

function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/**
 * Normal approximation on paired per-eval deltas. With fewer than 2 pairs the
 * variance is unknown, so the noise floor is the full range (1).
 */
export function pairedDeltaInterval(deltas: number[]): {
  mean: number;
  half: number;
} {
  const m = deltas.length;
  if (m === 0) {
    return { mean: 0, half: 1 };
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / m;
  if (m < 2) {
    return { mean, half: 1 };
  }
  const variance = deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / (m - 1);
  return { mean, half: Math.min(1, (Z95 * Math.sqrt(variance)) / Math.sqrt(m)) };
}

export function compareSplit(
  evalIds: string[],
  baseline: Map<string, EvalTally>,
  candidate: Map<string, EvalTally>,
): SplitComparison {
  if (evalIds.length === 0) {
    return {
      n_evals: 0,
      baseline_pass_rate: 0,
      candidate_pass_rate: 0,
      delta: 0,
      ci95: [0, 0],
      noise_floor: 0,
      n_regressed: 0,
      n_flaky: { baseline: 0, candidate: 0 },
      n_error: { baseline: 0, candidate: 0 },
    };
  }
  const deltas: number[] = [];
  let bk = 0;
  let bn = 0;
  let ck = 0;
  let cn = 0;
  let regressed = 0;
  const flaky = { baseline: 0, candidate: 0 };
  const errors = { baseline: 0, candidate: 0 };
  for (const id of evalIds) {
    const b = baseline.get(id) ?? { k: 0, n: 0 };
    const c = candidate.get(id) ?? { k: 0, n: 0 };
    bk += b.k;
    bn += b.n;
    ck += c.k;
    cn += c.n;
    if (b.n === 0) errors.baseline += 1;
    if (c.n === 0) errors.candidate += 1;
    if (b.k > 0 && b.k < b.n) flaky.baseline += 1;
    if (c.k > 0 && c.k < c.n) flaky.candidate += 1;
    if (b.n > 0 && c.n > 0) {
      deltas.push(c.k / c.n - b.k / b.n);
      if (b.k === b.n && c.k === 0) regressed += 1;
    }
  }
  const { mean, half } = pairedDeltaInterval(deltas);
  return {
    n_evals: evalIds.length,
    baseline_pass_rate: round(bn === 0 ? 0 : bk / bn),
    candidate_pass_rate: round(cn === 0 ? 0 : ck / cn),
    delta: round(mean),
    ci95: [round(clamp(mean - half)), round(clamp(mean + half))],
    noise_floor: round(half),
    n_regressed: regressed,
    n_flaky: flaky,
    n_error: errors,
  };
}

/**
 * Verdict rules. `check` is holdout, or train when the set has no holdout.
 * 1. check has a regressed eval, or check or train goes down beyond noise: revert_regressed.
 * 2. objective cost and cost per call drops by more than COST_NOISE_FRACTION: keep.
 * 3. check goes up beyond noise: keep.
 * 4. holdout exists and train goes up beyond noise: revert_overfit.
 * 5. else within_noise.
 */
export function decideVerdict(opts: {
  train: SplitComparison;
  holdout: SplitComparison;
  objective: Objective;
  baselineCostPerCall: number;
  candidateCostPerCall: number;
}): { verdict: Exclude<Verdict, "not_comparable">; reason: string } {
  const hasHoldout = opts.holdout.n_evals > 0;
  const check = hasHoldout ? opts.holdout : opts.train;
  const label = hasHoldout ? "holdout" : "train";

  if (check.n_regressed > 0) {
    return {
      verdict: "revert_regressed",
      reason: `${check.n_regressed} ${label} evals fail on every rep. The baseline passed them on every rep.`,
    };
  }
  if (check.ci95[1] < 0) {
    return {
      verdict: "revert_regressed",
      reason: `The ${label} pass rate goes down by more than the noise.`,
    };
  }
  if (opts.train.ci95[1] < 0) {
    return {
      verdict: "revert_regressed",
      reason: "The train pass rate goes down by more than the noise.",
    };
  }
  if (
    opts.objective === "cost" &&
    opts.candidateCostPerCall < opts.baselineCostPerCall * (1 - COST_NOISE_FRACTION)
  ) {
    return {
      verdict: "keep",
      reason: `The cost per call goes down. The ${label} pass rate does not go down by more than the noise.`,
    };
  }
  if (check.ci95[0] > 0) {
    return {
      verdict: "keep",
      reason: `The ${label} pass rate goes up by more than the noise.`,
    };
  }
  if (hasHoldout && opts.train.ci95[0] > 0) {
    return {
      verdict: "revert_overfit",
      reason:
        "The train pass rate goes up by more than the noise. The holdout pass rate does not.",
    };
  }
  return { verdict: "within_noise", reason: "The change is not larger than the noise." };
}
