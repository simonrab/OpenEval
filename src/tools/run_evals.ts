import type Database from "better-sqlite3";
import {
  recheckModelIds,
  validateRecheckNamedModel,
} from "../ci/recheck.js";
import {
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
import { missingKeysRefError, projectExists } from "../keys.js";
import { DEFAULT_MODELS } from "../runner/openrouter.js";
import { hasEnoughTrustedEvals } from "../runner/worker.js";
import { resolveMarkUrlForSet } from "./get_label_status.js";
import type { ToolHandler } from "../dispatch.js";
import { runEvalsOutputSchema, type runEvalsInputSchema } from "./schema.js";
import type { z } from "zod";

type RunEvalsInput = z.infer<typeof runEvalsInputSchema>;

function resolveModels(models: string[] | null | undefined): string[] {
  if (models && models.length > 0) {
    return models;
  }
  return [...DEFAULT_MODELS];
}

function estimateCost(modelCount: number, evalCount: number): number {
  return Math.round(modelCount * evalCount * 0.05 * 100) / 100;
}

function estimateEta(modelCount: number, evalCount: number): number {
  return modelCount * evalCount * 3;
}

export const handleRunEvals: ToolHandler = (body, ctx) => {
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

  const models =
    intent === "recheck" && input.named_model
      ? recheckModelIds(input.named_model)
      : resolveModels(input.models ?? undefined);
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
