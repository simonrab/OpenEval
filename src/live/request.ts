import type { PolicyModel } from "../policy.js";
import type { ModelSettings } from "../runner/openrouter.js";

export type SystemPromptSource = "policy" | "app" | "none";

const SETTING_KEYS = ["temperature", "top_p", "max_tokens", "reasoning_effort"] as const;

/** The setup id for a target entry. Format 1 entries have no candidate_id. */
export function entryCandidateId(entry: PolicyModel): string {
  return entry.candidate_id ?? entry.model_id;
}

/**
 * App settings, then policy settings on top. A policy field wins only when the
 * policy sets it. Fields the policy does not set keep the app value.
 */
export function mergeSettings(
  app: ModelSettings | undefined,
  policy: ModelSettings | undefined,
): ModelSettings | undefined {
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) {
    const value = policy?.[key] ?? app?.[key];
    if (value != null) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? (out as ModelSettings) : undefined;
}

/**
 * System prompt rule. The policy prompt is sent only when the app opts in;
 * then it replaces the app system prompt. Without opt-in the app prompt (if
 * any) is sent and the policy prompt is not.
 */
export function pickSystemPrompt(
  entry: PolicyModel,
  appSystem: string | undefined,
  applyPolicySystemPrompt: boolean,
): { text: string | undefined; source: SystemPromptSource } {
  if (applyPolicySystemPrompt && entry.system_prompt) {
    return { text: entry.system_prompt, source: "policy" };
  }
  if (appSystem) {
    return { text: appSystem, source: "app" };
  }
  return { text: undefined, source: "none" };
}
