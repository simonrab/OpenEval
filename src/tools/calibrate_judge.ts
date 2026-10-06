import type { z } from "zod";
import type { ToolHandler } from "../dispatch.js";
import { agentError, projectNotFoundError, suiteNotFoundError } from "../errors.js";
import { getEvalSet, getIdempotentResponse, storeIdempotentResponse } from "../eval-set.js";
import {
  agreementStats,
  JUDGE_MIN_ACCURACY,
  JUDGE_MIN_KAPPA,
  JUDGE_MIN_TEST_ITEMS,
  trustDecision,
  type Verdict,
} from "../judge/judge.js";
import { makeJudgeFn } from "../judge/runner.js";
import {
  calibrationSplit,
  getJudge,
  itemsFingerprint,
  listCalibrationItems,
  saveCalibration,
} from "../judge/store.js";
import { deriveWrapKey, missingKeysRefError, projectExists, readSecret } from "../keys.js";
import { createSpendGate } from "../runner/spend.js";
import { resolveMarkUrlForSet } from "./get_label_status.js";
import { calibrateJudgeOutputSchema, type calibrateJudgeInputSchema } from "./schema.js";
import { ErrorCode, type NextAction } from "./types.js";

type Input = z.infer<typeof calibrateJudgeInputSchema>;

function inputError(input: Input, message: string, tool: "configure_judge" | "calibrate_judge") {
  const args = { project_id: input.project_id, eval_set_id: input.eval_set_id };
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message,
    retryable: true,
    suggested_tool: tool,
    suggested_args: args,
    next_action: { tool, args, ask_human: null },
  });
}

/**
 * Run the judge on held-out outputs that people marked. Trust the judge only
 * when it agrees with people. People stay the source of truth.
 */
export const handleCalibrateJudge: ToolHandler = async (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("calibrate_judge requires db on ToolContext");
  }
  const input = body as Input;
  const cached = getIdempotentResponse(db, "calibrate_judge", input.idempotency_key);
  if (cached) {
    return cached;
  }
  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }
  const evalSet = getEvalSet(db, input.eval_set_id);
  if (!evalSet || evalSet.project_id !== input.project_id) {
    return { status: 404, body: suiteNotFoundError(input.eval_set_id) };
  }
  const judge = getJudge(db, input.eval_set_id);
  if (!judge) {
    return {
      status: 400,
      body: inputError(input, "No judge is set for this eval set. Call configure_judge first.", "configure_judge"),
    };
  }
  if (!input.keys_ref) {
    return { status: 400, body: missingKeysRefError(input.project_id) };
  }
  if (input.max_eval_spend_usd <= 0) {
    const args = { project_id: input.project_id, eval_set_id: input.eval_set_id, max_eval_spend_usd: 1 };
    return {
      status: 400,
      body: agentError({
        code: ErrorCode.COST_CAP_REQUIRED,
        message: "max_eval_spend_usd must be more than 0 to calibrate a judge",
        retryable: true,
        suggested_tool: "calibrate_judge",
        suggested_args: args,
        next_action: { tool: "calibrate_judge", args, ask_human: null },
      }),
    };
  }
  if (!ctx.openRouter) {
    return { status: 400, body: inputError(input, "Model calls are not available. Retry calibrate_judge.", "calibrate_judge") };
  }
  let customerKey: string;
  try {
    customerKey = readSecret(db, deriveWrapKey(ctx.apiKey ?? ""), input.keys_ref);
  } catch {
    return { status: 400, body: missingKeysRefError(input.project_id) };
  }

  const items = listCalibrationItems(db, input.eval_set_id);
  const { train, test } = calibrationSplit(db, input.eval_set_id, items);
  const gate = createSpendGate(input.max_eval_spend_usd);
  const judgeFn = makeJudgeFn(judge, { client: ctx.openRouter, apiKey: customerKey, gate });

  let capHit = false;
  let nErrors = 0;
  const pairs: Array<{ human: Verdict; judge: Verdict | null }> = [];
  // Too few items cannot pass, so do not spend money on them.
  if (test.length >= JUDGE_MIN_TEST_ITEMS) {
    for (const item of test) {
      const result = await judgeFn(item.input, item.output);
      if (result === "cap") {
        capHit = true;
        break;
      }
      if (!result.ok) {
        nErrors += 1;
      }
      pairs.push({ human: item.human, judge: result.ok ? result.verdict : null });
    }
  }

  const stats = pairs.length > 0 ? agreementStats(pairs) : null;
  const decision = capHit
    ? {
        trusted: false,
        reason: `The spend cap stopped calibration after ${pairs.length} of ${test.length} outputs. Raise max_eval_spend_usd.`,
      }
    : trustDecision({
        n_test: test.length,
        accuracy: stats?.accuracy ?? null,
        kappa: stats?.kappa ?? null,
      });
  const saved = saveCalibration(db, judge, input.eval_set_id, {
    items_fingerprint: itemsFingerprint(items),
    status: decision.trusted ? "trusted" : "uncalibrated",
    reason: decision.reason,
    n_items: items.length,
    n_train: train.length,
    n_test: test.length,
    n_agree: stats?.n_agree ?? 0,
    n_judge_errors: nErrors,
    accuracy: stats ? round(stats.accuracy) : null,
    kappa: stats ? round(stats.kappa) : null,
    cost_usd: gate.spent,
  });

  const args = { project_id: input.project_id, eval_set_id: input.eval_set_id };
  const markUrl = resolveMarkUrlForSet(
    db,
    ctx.baseUrl ?? "http://127.0.0.1:3000",
    ctx.apiKey ?? "",
    input.eval_set_id,
  );
  let nextAction: NextAction;
  if (decision.trusted) {
    nextAction = { tool: "run_evals", args, ask_human: null };
  } else if (capHit) {
    nextAction = { tool: "calibrate_judge", args, ask_human: null };
  } else if (test.length < JUDGE_MIN_TEST_ITEMS) {
    nextAction = markUrl
      ? { tool: "get_label_status", args, ask_human: "open mark_url" }
      : { tool: "queue_for_labeling", args, ask_human: null };
  } else {
    // The judge disagrees with people. Change the rubric or model, then calibrate again.
    nextAction = { tool: "configure_judge", args, ask_human: null };
  }

  const output = calibrateJudgeOutputSchema.parse({
    judge_id: judge.id,
    calibration_id: saved.id,
    eval_set_id: input.eval_set_id,
    config_hash: judge.config_hash,
    status: saved.status,
    reason: saved.reason,
    n_human_marked: items.length,
    n_train: train.length,
    n_test: test.length,
    n_agree: saved.n_agree,
    n_judge_errors: nErrors,
    accuracy: saved.accuracy,
    kappa: saved.kappa,
    cost_usd: saved.cost_usd,
    thresholds: {
      min_n_test: JUDGE_MIN_TEST_ITEMS,
      min_accuracy: JUDGE_MIN_ACCURACY,
      min_kappa: JUDGE_MIN_KAPPA,
    },
    mark_url: markUrl,
    next_action: nextAction,
  });
  storeIdempotentResponse(db, "calibrate_judge", input.idempotency_key, 200, output, input.project_id);
  return { status: 200, body: output };
};

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
