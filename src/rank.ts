import {
  catalogById,
  matchesAnyModelPattern,
  type CatalogModel,
} from "./runner/catalog.js";
import { baseModelId } from "./runner/candidates.js";

export type JobLimits = {
  needs_images?: boolean;
  modalities?: string[];
  max_wait_ms?: number;
  max_spend_usd_per_1k?: number;
  allowed_models?: string[];
  excluded_models?: string[];
  system_prompt?: string;
};

export type RunResultRow = {
  model_id: string;
  eval_id: string;
  passed: boolean;
  time_ms: number;
  cost_usd: number;
  /** error rows are model calls that failed after retries. They are not scored. */
  outcome?: "scored" | "error";
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost_source?: string | null;
};

export type ModelStats = {
  modelId: string;
  passedAll: boolean;
  failingEvalIds: string[];
  nPass: number;
  nFail: number;
  p50TimeMs: number;
  p95TimeMs: number;
  totalCostUsd: number;
  spendPer1kUsd: number;
  /** Scored model calls, across all reps. */
  nTrials: number;
  nTrialPass: number;
  /** Trial pass rate and its 95% Wilson interval. */
  passRate: number;
  passRateLow: number;
  passRateHigh: number;
  /** Evals where some reps passed and some failed. */
  flakyEvalIds: string[];
  /** Evals with no scored rep because every call failed. */
  errorEvalIds: string[];
  /** provider, estimate, caller, or mixed. */
  costSource: string;
};

export type PickResult =
  | { outcome: "named"; winner: string; backups: string[]; winnerStats: ModelStats }
  | { outcome: "does_not_work"; failingEvalIds: string[] };

const ESTIMATED_TOKENS_PER_EVAL = 500;

type ModelCatalogEntry = {
  supportsImages: boolean;
  listCostPer1kUsd: number;
};

export const MODEL_CATALOG: Record<string, ModelCatalogEntry> = {
  "openai/gpt-4o-mini": { supportsImages: true, listCostPer1kUsd: 0.15 },
  "google/gemini-flash-1.5": { supportsImages: true, listCostPer1kUsd: 0.075 },
  "anthropic/claude-3-haiku": { supportsImages: true, listCostPer1kUsd: 0.25 },
  "meta-llama/llama-3.1-8b-instruct": {
    supportsImages: false,
    listCostPer1kUsd: 0.05,
  },
  "mistralai/mistral-7b-instruct": {
    supportsImages: false,
    listCostPer1kUsd: 0.05,
  },
};

function catalogEntry(
  modelId: string,
  live: Map<string, CatalogModel> | undefined,
): ModelCatalogEntry {
  const fromLive = live?.get(modelId);
  if (fromLive) {
    return {
      supportsImages: fromLive.supportsImages,
      listCostPer1kUsd: fromLive.listCostPer1kUsd,
    };
  }
  return (
    MODEL_CATALOG[modelId] ?? {
      supportsImages: false,
      listCostPer1kUsd: Number.POSITIVE_INFINITY,
    }
  );
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}


/** 95% Wilson score interval for k passes in n trials. */
export function wilsonInterval(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) {
    return { low: 0, high: 1 };
  }
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

function costSourceOf(rows: RunResultRow[]): string {
  const sources = new Set(rows.map((r) => r.cost_source ?? "estimate"));
  if (sources.size === 0) {
    return "estimate";
  }
  return sources.size === 1 ? [...sources][0]! : "mixed";
}

export function aggregateModelStats(
  results: RunResultRow[],
  trustedEvalIds: string[],
): ModelStats[] {
  const trustedSet = new Set(trustedEvalIds);
  const byModel = new Map<string, RunResultRow[]>();
  for (const row of results) {
    if (!trustedSet.has(row.eval_id)) {
      continue;
    }
    const list = byModel.get(row.model_id) ?? [];
    list.push(row);
    byModel.set(row.model_id, list);
  }

  const stats: ModelStats[] = [];
  for (const [modelId, rows] of byModel) {
    const scored = rows.filter((r) => (r.outcome ?? "scored") === "scored");
    const byEval = new Map<string, RunResultRow[]>();
    for (const r of scored) {
      const list = byEval.get(r.eval_id) ?? [];
      list.push(r);
      byEval.set(r.eval_id, list);
    }
    const attemptedIds = new Set(rows.map((r) => r.eval_id));
    const errorEvalIds = trustedEvalIds.filter(
      (id) => attemptedIds.has(id) && !byEval.has(id),
    );
    const missing = trustedEvalIds.filter((id) => !byEval.has(id));

    // An eval passes only when every scored rep passes.
    const passingIds: string[] = [];
    const failingIds: string[] = [];
    const flakyEvalIds: string[] = [];
    for (const [evalId, evalRows] of byEval) {
      const passes = evalRows.filter((r) => r.passed).length;
      if (passes === evalRows.length) {
        passingIds.push(evalId);
      } else {
        failingIds.push(evalId);
        if (passes > 0) {
          flakyEvalIds.push(evalId);
        }
      }
    }

    const nTrials = scored.length;
    const nTrialPass = scored.filter((r) => r.passed).length;
    const interval = wilsonInterval(nTrialPass, nTrials);
    const times = scored.map((r) => r.time_ms);
    const totalCostUsd = rows.reduce((sum, r) => sum + r.cost_usd, 0);
    const tokens = scored.reduce(
      (sum, r) => sum + (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0),
      0,
    );
    const tokenCount =
      tokens > 0 ? tokens : Math.max(scored.length, 1) * ESTIMATED_TOKENS_PER_EVAL;
    const spendPer1kUsd = (totalCostUsd / tokenCount) * 1000;

    stats.push({
      modelId,
      passedAll: missing.length === 0 && failingIds.length === 0,
      failingEvalIds: [...new Set([...failingIds, ...missing])],
      nPass: passingIds.length,
      nFail: failingIds.length + missing.length,
      p50TimeMs: percentile(times, 50),
      p95TimeMs: percentile(times, 95),
      totalCostUsd,
      spendPer1kUsd,
      nTrials,
      nTrialPass,
      passRate: nTrials === 0 ? 0 : nTrialPass / nTrials,
      passRateLow: interval.low,
      passRateHigh: interval.high,
      flakyEvalIds,
      errorEvalIds,
      costSource: costSourceOf(scored),
    });
  }
  return stats;
}

export function applyHardLimits(
  stats: ModelStats[],
  limits: JobLimits | null,
  liveCatalog?: CatalogModel[],
): ModelStats[] {
  if (!limits) {
    return stats;
  }
  const live = liveCatalog ? catalogById(liveCatalog) : undefined;
  return stats.filter((s) => {
    const catalog = catalogEntry(baseModelId(s.modelId), live);
    if (limits.needs_images && !catalog.supportsImages) {
      return false;
    }
    if (
      limits.max_wait_ms != null &&
      s.p95TimeMs > limits.max_wait_ms
    ) {
      return false;
    }
    const spendLimit = limits.max_spend_usd_per_1k;
    if (spendLimit != null) {
      const observed = s.spendPer1kUsd;
      const list = catalog.listCostPer1kUsd;
      const spend = Number.isFinite(observed) && observed > 0 ? observed : list;
      if (spend > spendLimit) {
        return false;
      }
    }
    if (
      limits.allowed_models &&
      limits.allowed_models.length > 0 &&
      !matchesAnyModelPattern(baseModelId(s.modelId), limits.allowed_models)
    ) {
      return false;
    }
    if (
      limits.excluded_models &&
      limits.excluded_models.length > 0 &&
      matchesAnyModelPattern(baseModelId(s.modelId), limits.excluded_models)
    ) {
      return false;
    }
    return true;
  });
}

function compareCheapestFast(a: ModelStats, b: ModelStats): number {
  if (a.totalCostUsd !== b.totalCostUsd) {
    return a.totalCostUsd - b.totalCostUsd;
  }
  return a.p50TimeMs - b.p50TimeMs;
}

/** Spec: name a costlier or slower model only if quality is clearly better. */
const QUALITY_LIFT = 0.05;

function passRate(s: ModelStats): number {
  return s.passRate;
}

function undominatedOnCostAndTime(stats: ModelStats[]): ModelStats[] {
  return stats.filter((a) => {
    return !stats.some((b) => {
      if (b.modelId === a.modelId) {
        return false;
      }
      const cheaperOrEqual = b.totalCostUsd <= a.totalCostUsd;
      const fasterOrEqual = b.p50TimeMs <= a.p50TimeMs;
      const strict = b.totalCostUsd < a.totalCostUsd || b.p50TimeMs < a.p50TimeMs;
      return cheaperOrEqual && fasterOrEqual && strict;
    });
  });
}

export function pickNamedModel(
  stats: ModelStats[],
  limits: JobLimits | null,
  liveCatalog?: CatalogModel[],
): PickResult {
  const afterLimits = applyHardLimits(stats, limits, liveCatalog);
  const passers = afterLimits.filter((s) => s.passedAll);
  if (passers.length === 0) {
    const failingEvalIds = [
      ...new Set(afterLimits.flatMap((s) => s.failingEvalIds)),
    ];
    return { outcome: "does_not_work", failingEvalIds };
  }

  const cheapestFast = [...passers].sort(compareCheapestFast)[0]!;
  const clearlyBetter = passers.filter(
    (s) => passRate(s) - passRate(cheapestFast) >= QUALITY_LIFT,
  );
  const winner =
    clearlyBetter.length > 0
      ? [...clearlyBetter].sort(compareCheapestFast)[0]!
      : cheapestFast;

  const backups = undominatedOnCostAndTime(passers)
    .filter((s) => s.modelId !== winner.modelId)
    .sort(compareCheapestFast)
    .slice(0, 2)
    .map((s) => s.modelId);

  return {
    outcome: "named",
    winner: winner.modelId,
    backups,
    winnerStats: winner,
  };
}
