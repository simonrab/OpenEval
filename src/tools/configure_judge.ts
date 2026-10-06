import type { z } from "zod";
import type { ToolHandler } from "../dispatch.js";
import { agentError, projectNotFoundError, suiteNotFoundError } from "../errors.js";
import { getEvalSet, getIdempotentResponse, storeIdempotentResponse } from "../eval-set.js";
import { DEFAULT_JUDGE_SETTINGS, defaultRubric } from "../judge/judge.js";
import { judgeStatus, listCalibrationItems, saveJudge } from "../judge/store.js";
import { projectExists } from "../keys.js";
import { getJobGoodMeans } from "../mark/store.js";
import { configureJudgeOutputSchema, type configureJudgeInputSchema } from "./schema.js";
import { ErrorCode } from "./types.js";

type Input = z.infer<typeof configureJudgeInputSchema>;

/** Set the judge for an eval-set lineage. It is not trusted until calibrate_judge passes. */
export const handleConfigureJudge: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("configure_judge requires db on ToolContext");
  }
  const input = body as Input;
  const cached = getIdempotentResponse(db, "configure_judge", input.idempotency_key);
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

  const rubric = input.rubric?.trim() || defaultRubric(getJobGoodMeans(db, input.eval_set_id));
  if (rubric.length === 0) {
    const args = { project_id: input.project_id, eval_set_id: input.eval_set_id };
    return {
      status: 400,
      body: agentError({
        code: ErrorCode.INVALID_INPUT,
        message: "The job has no good-means text. Pass a rubric.",
        retryable: true,
        suggested_tool: "configure_judge",
        suggested_args: args,
        next_action: { tool: "configure_judge", args, ask_human: "what good means" },
      }),
    };
  }

  const judge = saveJudge(db, input.project_id, input.eval_set_id, {
    judge_model: input.judge_model,
    rubric,
    settings: { ...DEFAULT_JUDGE_SETTINGS, ...(input.settings ?? {}) },
  });
  const status = judgeStatus(db, input.eval_set_id);
  const output = configureJudgeOutputSchema.parse({
    judge_id: judge.id,
    eval_set_id: input.eval_set_id,
    judge_model: judge.judge_model,
    config_hash: judge.config_hash,
    rubric_source: input.rubric?.trim() ? "input" : "job",
    status: status.status === "none" ? "uncalibrated" : status.status,
    reason: status.reason,
    n_human_marked: listCalibrationItems(db, input.eval_set_id).length,
    next_action:
      status.status === "trusted"
        ? {
            tool: "run_evals",
            args: { project_id: input.project_id, eval_set_id: input.eval_set_id },
            ask_human: null,
          }
        : {
            tool: "calibrate_judge",
            args: { project_id: input.project_id, eval_set_id: input.eval_set_id },
            ask_human: null,
          },
  });
  storeIdempotentResponse(db, "configure_judge", input.idempotency_key, 200, output, input.project_id);
  return { status: 200, body: output };
};
