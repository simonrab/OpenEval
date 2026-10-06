import type { DispatchResult, ToolContext } from "../dispatch.js";
import { scopeForbiddenError } from "../errors.js";
import { getKeyMeta } from "../keys.js";
import type { ToolName } from "./types.js";

/**
 * The only tools an optimizer key can call. get_eval_report is redacted.
 * configure_judge and calibrate_judge stay out: the optimizer must not tune its own grader.
 */
export const OPTIMIZER_TOOLS: readonly ToolName[] = [
  "get_eval_inputs",
  "submit_outputs",
  "run_evals",
  "get_training_failures",
  "get_verdict",
  "get_eval_report",
];

export function isOptimizerScope(ctx: ToolContext): boolean {
  return ctx.scope?.scope === "optimizer";
}

function forbidden(message: string): DispatchResult {
  return { status: 403, body: scopeForbiddenError(message) };
}

/**
 * Gate one call for an optimizer key. input null checks the tool name only.
 * Returns null when the call can go on.
 */
export function checkScope(
  ctx: ToolContext,
  name: ToolName,
  input: unknown,
): DispatchResult | null {
  const scope = ctx.scope;
  if (scope?.scope !== "optimizer") {
    return null;
  }
  if (input === null) {
    return OPTIMIZER_TOOLS.includes(name)
      ? null
      : forbidden(`An optimizer key cannot call ${name}. Use a full key.`);
  }
  const body = input as Record<string, unknown>;
  if (body.project_id !== scope.projectId) {
    return forbidden("This key is for a different project.");
  }
  if (name === "submit_outputs" && typeof body.keys_ref === "string" && ctx.db) {
    const meta = getKeyMeta(ctx.db, body.keys_ref);
    if (!meta || meta.project_id !== scope.projectId) {
      return forbidden("This keys_ref is for a different project.");
    }
  }
  if (name === "run_evals") {
    if (body.intent === "recheck" || body.named_model != null) {
      return forbidden("An optimizer key cannot do a recheck run.");
    }
    const hasCandidates = Array.isArray(body.candidates) && body.candidates.length > 0;
    const hasModels = Array.isArray(body.models) && body.models.length > 0;
    if (!hasCandidates && !hasModels) {
      return forbidden("An optimizer key must pass candidates or models to run_evals.");
    }
    if (typeof body.keys_ref === "string" && ctx.db) {
      const meta = getKeyMeta(ctx.db, body.keys_ref);
      if (!meta || meta.project_id !== scope.projectId) {
        return forbidden("This keys_ref is for a different project.");
      }
    }
  }
  return null;
}

/** Links open human screens that show every eval. An optimizer key gets none. */
export function redactForScope(ctx: ToolContext, result: DispatchResult): DispatchResult {
  if (!isOptimizerScope(ctx) || result.body === null || typeof result.body !== "object") {
    return result;
  }
  const body = { ...(result.body as Record<string, unknown>) };
  for (const key of Object.keys(body)) {
    if (key.endsWith("_url") && typeof body[key] === "string") {
      body[key] = null;
    }
  }
  return { status: result.status, body };
}
