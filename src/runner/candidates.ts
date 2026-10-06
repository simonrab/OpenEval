import type { ModelSettings } from "./openrouter.js";

/**
 * A candidate is one setup to score: a model, its settings, and an optional
 * system prompt variant. The id is `model` or `model#label`.
 */
export type Candidate = {
  id: string;
  model: string;
  settings?: ModelSettings;
  system_prompt?: string;
};

/** The catalog model id for a candidate id (`model#label` -> `model`). */
export function baseModelId(candidateId: string): string {
  const hash = candidateId.indexOf("#");
  return hash === -1 ? candidateId : candidateId.slice(0, hash);
}

/** Candidates for a run. Old runs stored model ids only. */
export function runCandidates(
  modelsJson: string,
  candidatesJson: string | null,
): Candidate[] {
  if (candidatesJson) {
    return JSON.parse(candidatesJson) as Candidate[];
  }
  const models = JSON.parse(modelsJson) as string[];
  return models.map((id) => ({ id, model: baseModelId(id) }));
}
