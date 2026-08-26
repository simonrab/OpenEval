import {
  catalogById,
  matchesAnyModelPattern,
  type CatalogModel,
} from "./runner/catalog.js";

export type JobLimits = {
  needs_images?: boolean;
  modalities?: string[];
  max_wait_ms?: number;
  max_spend_usd_per_1k?: number;
  allowed_models?: string[];
  excluded_models?: string[];
};

export type RunResultRow = {
  model_id: string;
  eval_id: string;
  passed: boolean;
  time_ms: number;
  cost_usd: number;
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
    const scoredEvalIds = new Set(rows.map((r) => r.eval_id));
    const missing = trustedEvalIds.filter((id) => !scoredEvalIds.has(id));
    const failingEvalIds = [
      ...rows.filter((r) => !r.passed).map((r) => r.eval_id),
      ...missing,
    ];
    const nPass = rows.filter((r) => r.passed).length;
    const nFail = rows.length - nPass + missing.length;
    const times = rows.map((r) => r.time_ms);
    const totalCostUsd = rows.reduce((sum, r) => sum + r.cost_usd, 0);
    const tokenEstimate = Math.max(rows.length, 1) * ESTIMATED_TOKENS_PER_EVAL;
    const spendPer1kUsd = (totalCostUsd / tokenEstimate) * 1000;
    const passedAll =
      missing.length === 0 &&
      rows.length === trustedEvalIds.length &&
      rows.every((r) => r.passed);

    stats.push({
      modelId,
      passedAll,
      failingEvalIds: [...new Set(failingEvalIds)],
      nPass,
      nFail,
      p50TimeMs: percentile(times, 50),
      p95TimeMs: percentile(times, 95),
      totalCostUsd,
      spendPer1kUsd,
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
    const catalog = catalogEntry(s.modelId, live);
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
      !matchesAnyModelPattern(s.modelId, limits.allowed_models)
    ) {
      return false;
    }
    if (
      limits.excluded_models &&
      limits.excluded_models.length > 0 &&
      matchesAnyModelPattern(s.modelId, limits.excluded_models)
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
  const n = s.nPass + s.nFail;
  return n === 0 ? 0 : s.nPass / n;
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
