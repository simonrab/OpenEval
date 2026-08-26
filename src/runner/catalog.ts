export const DEFAULT_SHORT_LIST_SIZE = 5;

export type CatalogModel = {
  id: string;
  supportsImages: boolean;
  inputModalities: string[];
  listCostPer1kUsd: number;
  created: number;
};

export type CatalogLimits = {
  needs_images?: boolean;
  modalities?: string[];
  max_spend_usd_per_1k?: number;
  allowed_models?: string[];
  excluded_models?: string[];
};

export function matchesModelPattern(modelId: string, pattern: string): boolean {
  if (pattern.endsWith("/*")) {
    return modelId.startsWith(pattern.slice(0, -1));
  }
  return modelId === pattern;
}

export function matchesAnyModelPattern(
  modelId: string,
  patterns: string[],
): boolean {
  return patterns.some((p) => matchesModelPattern(modelId, p));
}

export function providerPrefix(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash === -1 ? modelId : modelId.slice(0, slash);
}

function numberOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Average of prompt and completion price, in USD per 1k tokens. */
export function listCostPer1kUsd(promptPerToken: number, completionPerToken: number): number {
  return (promptPerToken + completionPerToken) * 500;
}

export function parseOpenRouterModels(payload: unknown): CatalogModel[] {
  if (payload === null || typeof payload !== "object") {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const out: CatalogModel[] = [];
  for (const raw of data) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    const row = raw as {
      id?: unknown;
      created?: unknown;
      architecture?: { input_modalities?: unknown };
      pricing?: { prompt?: unknown; completion?: unknown };
    };
    if (typeof row.id !== "string" || !row.id.includes("/")) {
      continue;
    }
    const mods = Array.isArray(row.architecture?.input_modalities)
      ? row.architecture.input_modalities.filter(
          (m): m is string => typeof m === "string",
        )
      : ["text"];
    const prompt = numberOrZero(row.pricing?.prompt);
    const completion = numberOrZero(row.pricing?.completion);
    out.push({
      id: row.id,
      supportsImages: mods.includes("image"),
      inputModalities: mods,
      listCostPer1kUsd: listCostPer1kUsd(prompt, completion),
      created: numberOrZero(row.created),
    });
  }
  return out;
}

export function catalogModelFitsLimits(
  model: CatalogModel,
  limits: CatalogLimits | null,
): boolean {
  if (!limits) {
    return true;
  }
  if (limits.needs_images && !model.supportsImages) {
    return false;
  }
  if (limits.modalities && limits.modalities.length > 0) {
    for (const need of limits.modalities) {
      if (need === "text") {
        continue;
      }
      if (!model.inputModalities.includes(need)) {
        return false;
      }
    }
  }
  if (
    limits.max_spend_usd_per_1k != null &&
    model.listCostPer1kUsd > limits.max_spend_usd_per_1k
  ) {
    return false;
  }
  if (
    limits.allowed_models &&
    limits.allowed_models.length > 0 &&
    !matchesAnyModelPattern(model.id, limits.allowed_models)
  ) {
    return false;
  }
  if (
    limits.excluded_models &&
    limits.excluded_models.length > 0 &&
    matchesAnyModelPattern(model.id, limits.excluded_models)
  ) {
    return false;
  }
  return true;
}

function isFreeTier(model: CatalogModel): boolean {
  return model.id.endsWith(":free") || model.listCostPer1kUsd <= 0;
}

/** Drop models more than 180 days behind the newest id in this catalog. */
const CURRENT_WINDOW_S = 180 * 24 * 60 * 60;

function preferCurrent(models: CatalogModel[]): CatalogModel[] {
  if (models.length === 0) {
    return models;
  }
  const maxCreated = Math.max(...models.map((m) => m.created));
  const floor = maxCreated - CURRENT_WINDOW_S;
  const current = models.filter((m) => m.created >= floor);
  return current.length > 0 ? current : models;
}

function compareCostThenRecency(a: CatalogModel, b: CatalogModel): number {
  if (a.listCostPer1kUsd !== b.listCostPer1kUsd) {
    return a.listCostPer1kUsd - b.listCostPer1kUsd;
  }
  return b.created - a.created;
}

/**
 * Keep models that are not beaten on both list cost and recency.
 * Recency is a stand-in for capability when we have not run evals yet.
 * Naming still uses this job’s evals, not a public ranking.
 */
export function undominatedOnCostAndRecency(
  models: CatalogModel[],
): CatalogModel[] {
  return models.filter((a) => {
    return !models.some((b) => {
      if (b.id === a.id) {
        return false;
      }
      const cheaperOrEqual = b.listCostPer1kUsd <= a.listCostPer1kUsd;
      const newerOrEqual = b.created >= a.created;
      const strict =
        b.listCostPer1kUsd < a.listCostPer1kUsd || b.created > a.created;
      return cheaperOrEqual && newerOrEqual && strict;
    });
  });
}

function takeDiverseThenFill(
  preferred: CatalogModel[],
  rest: CatalogModel[],
  n: number,
): CatalogModel[] {
  const picked: CatalogModel[] = [];
  const seenProvider = new Set<string>();

  const add = (model: CatalogModel): void => {
    if (picked.length >= n) {
      return;
    }
    if (picked.some((p) => p.id === model.id)) {
      return;
    }
    picked.push(model);
  };

  const addOnePerProvider = (source: CatalogModel[]): void => {
    for (const model of source) {
      if (picked.length >= n) {
        break;
      }
      const prefix = providerPrefix(model.id);
      if (seenProvider.has(prefix)) {
        continue;
      }
      seenProvider.add(prefix);
      add(model);
    }
  };

  addOnePerProvider(preferred);
  for (const model of preferred) {
    add(model);
  }
  addOnePerProvider(rest);
  for (const model of rest) {
    add(model);
  }
  return picked;
}

/**
 * Spec: default short list size 5, and that list must fit job limits.
 * Take current models on the cost/recency frontier first, then fill.
 * Naming still happens later from measured run cost/time among passers.
 */
export function pickDefaultModels(
  catalog: CatalogModel[],
  limits: CatalogLimits | null,
  n = DEFAULT_SHORT_LIST_SIZE,
): CatalogModel[] {
  const eligible = preferCurrent(
    catalog.filter((m) => catalogModelFitsLimits(m, limits)),
  );
  const paid = eligible.filter((m) => !isFreeTier(m));
  const pool = paid.length > 0 ? paid : eligible;
  const sorted = [...pool].sort(compareCostThenRecency);
  const frontier = [...undominatedOnCostAndRecency(pool)].sort(
    compareCostThenRecency,
  );
  const rest = sorted.filter((m) => !frontier.some((f) => f.id === m.id));
  return takeDiverseThenFill(frontier, rest, n);
}

export function catalogById(catalog: CatalogModel[]): Map<string, CatalogModel> {
  return new Map(catalog.map((m) => [m.id, m]));
}
