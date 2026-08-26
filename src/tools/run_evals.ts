import {
  recheckModelIds,
  validateRecheckNamedModel,
} from "../ci/recheck.js";
import {
  agentError,
  costCapRequiredError,
  needMoreEvalsError,
  projectNotFoundError,
  suiteNotFoundError,
} from "../errors.js";
import {
  getEvalSet,
  getIdempotentResponse,
  listMembers,
  storeIdempotentResponse,
} from "../eval-set.js";
import { newRunId } from "../ids.js";
import { getJobLimits } from "../job.js";
import { deriveWrapKey, missingKeysRefError, projectExists, readSecret } from "../keys.js";
import { pickDefaultModels } from "../runner/catalog.js";
import { hasEnoughTrustedEvals } from "../runner/worker.js";
import { resolveMarkUrlForSet } from "./get_label_status.js";
import type { ToolHandler } from "../dispatch.js";
import { runEvalsOutputSchema, type runEvalsInputSchema } from "./schema.js";
import { ErrorCode } from "./types.js";
import type { z } from "zod";

type RunEvalsInput = z.infer<typeof runEvalsInputSchema>;

function estimateCost(modelCount: number, evalCount: number): number {
  return Math.round(modelCount * evalCount * 0.05 * 100) / 100;
}

function estimateEta(modelCount: number, evalCount: number): number {
  return modelCount * evalCount * 3;
}

function noModelsFitError(): ReturnType<typeof agentError> {
  return agentError({
    code: ErrorCode.does_not_work,
    message: "No current models fit the job limits",
    retryable: false,
    suggested_tool: "run_evals",
    suggested_args: {},
    failing_eval_ids: [],
    next_action: {
      tool: null,
      args: {},
      ask_human: "none of the models passed; see failing_eval_ids",
    },
  });
}

function catalogUnavailableError(): ReturnType<typeof agentError> {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message: "Could not list current models. Retry run_evals.",
    retryable: true,
    suggested_tool: "run_evals",
    suggested_args: {},
    next_action: {
      tool: "run_evals",
      args: {},
      ask_human: null,
    },
  });
}

export const handleRunEvals: ToolHandler = async (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("run_evals requires db on ToolContext");
  }

  const input = body as RunEvalsInput;
  const existing = getIdempotentResponse(
    db,
    "run_evals",
    input.idempotency_key,
  );
  if (existing) {
    return existing;
  }

  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  if (!input.keys_ref) {
    return { status: 400, body: missingKeysRefError(input.project_id) };
  }

  const intent = input.intent ?? "new_feature";
  if (intent === "recheck" && input.max_eval_spend_usd <= 0) {
    return { status: 400, body: costCapRequiredError() };
  }

  const evalSet = getEvalSet(db, input.eval_set_id);
  if (!evalSet || evalSet.project_id !== input.project_id) {
    return { status: 404, body: suiteNotFoundError(input.eval_set_id) };
  }

  if (intent === "recheck" && input.named_model) {
    const mismatch = validateRecheckNamedModel(
      db,
      input.eval_set_id,
      input.named_model,
    );
    if (mismatch) {
      return { status: 400, body: mismatch };
    }
  }

  const members = listMembers(db, input.eval_set_id);
  if (!hasEnoughTrustedEvals(members)) {
    const markUrl = resolveMarkUrlForSet(
      db,
      ctx.baseUrl ?? "http://127.0.0.1:3000",
      ctx.apiKey ?? "",
      input.eval_set_id,
    );
    return {
      status: 400,
      body: needMoreEvalsError(input.project_id, input.eval_set_id, markUrl),
    };
  }

  let models: string[];
  if (intent === "recheck" && input.named_model) {
    models = recheckModelIds(input.named_model);
  } else if (input.models && input.models.length > 0) {
    models = input.models;
  } else {
    const openRouter = ctx.openRouter;
    if (!openRouter?.listModels || !ctx.apiKey) {
      return { status: 400, body: catalogUnavailableError() };
    }
    let customerKey: string;
    try {
      customerKey = readSecret(db, deriveWrapKey(ctx.apiKey), input.keys_ref);
    } catch {
      return { status: 400, body: missingKeysRefError(input.project_id) };
    }
    let catalog;
    try {
      catalog = await openRouter.listModels(customerKey);
    } catch {
      return { status: 400, body: catalogUnavailableError() };
    }
    const limits = getJobLimits(db, input.eval_set_id);
    const picked = pickDefaultModels(catalog, limits);
    if (picked.length === 0) {
      return { status: 400, body: noModelsFitError() };
    }
    models = picked.map((m) => m.id);
  }
  const trustedEvals = members.filter((m) => m.status === "trusted");
  const runId = newRunId();
  const now = new Date().toISOString();
  const version = input.eval_set_version ?? evalSet.version;

  db.prepare(
    `INSERT INTO runs
      (id, project_id, eval_set_id, eval_set_version, status, code, models,
       max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
       spend_usd, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    runId,
    input.project_id,
    input.eval_set_id,
    version,
    JSON.stringify(models),
    input.max_eval_spend_usd,
    input.keys_ref,
    intent,
    input.named_model ? JSON.stringify(input.named_model) : null,
    input.new_failures ? JSON.stringify(input.new_failures) : null,
    input.idempotency_key,
    now,
    now,
  );

  const output = runEvalsOutputSchema.parse({
    run_id: runId,
    status: "queued",
    eta_s: estimateEta(models.length, trustedEvals.length),
    est_cost_usd: estimateCost(models.length, trustedEvals.length),
    next_action: {
      tool: "get_eval_report",
      args: { project_id: input.project_id, run_id: runId },
      ask_human: null,
    },
  });

  storeIdempotentResponse(
    db,
    "run_evals",
    input.idempotency_key,
    200,
    output,
    input.project_id,
  );

  return { status: 200, body: output };
};
