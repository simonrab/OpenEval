import type { z } from "zod";
import type { ToolHandler } from "../dispatch.js";
import { agentError, projectNotFoundError } from "../errors.js";
import { listMembers } from "../eval-set.js";
import { projectExists } from "../keys.js";
import { listCandidateOutputs, type RunOutputRow } from "../runner/queue.js";
import { ensureEvalSplit } from "../splits.js";
import {
  candidateNotFoundError,
  loadProjectRun,
  runHasCandidate,
  runIsDone,
  runNotFoundError,
  truncateText,
} from "./referee.js";
import {
  getTrainingFailuresOutputSchema,
  type getTrainingFailuresInputSchema,
} from "./schema.js";
import { ErrorCode } from "./types.js";

type Input = z.infer<typeof getTrainingFailuresInputSchema>;

const DEFAULT_LIMIT = 5;
const INPUT_CHARS = 500;
const OUTPUT_CHARS = 1000;
const REASON_CHARS = 240;

type EvalState = "pass" | "fail" | "error";

function evalState(rows: RunOutputRow[]): { state: EvalState; flaky: boolean } {
  const scored = rows.filter((r) => r.outcome === "scored");
  if (scored.length === 0) {
    return { state: "error", flaky: false };
  }
  const passes = scored.filter((r) => r.passed === 1).length;
  if (passes === scored.length) {
    return { state: "pass", flaky: false };
  }
  return { state: "fail", flaky: passes > 0 };
}

function decodeCursor(cursor: string | null | undefined): number {
  const n = cursor ? Number.parseInt(cursor, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export const handleGetTrainingFailures: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("get_training_failures requires db on ToolContext");
  }
  const input = body as Input;
  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }
  const run = loadProjectRun(db, input.project_id, input.run_id);
  if (!run) {
    return { status: 404, body: runNotFoundError(input.run_id) };
  }
  if (!runHasCandidate(db, run, input.candidate_id)) {
    return { status: 404, body: candidateNotFoundError(run.id, input.candidate_id) };
  }
  if (!runIsDone(run)) {
    return {
      status: 409,
      body: agentError({
        code: ErrorCode.INVALID_INPUT,
        message: "The run is not done. Wait for the run, then call again.",
        retryable: true,
        suggested_tool: "get_eval_report",
        suggested_args: { project_id: input.project_id, run_id: run.id },
        next_action: {
          tool: "get_eval_report",
          args: { project_id: input.project_id, run_id: run.id },
          ask_human: null,
        },
      }),
    };
  }

  const { splits, directional } = ensureEvalSplit(db, run.eval_set_id);
  const members = listMembers(db, run.eval_set_id).filter((m) => splits.has(m.eval_id));
  const rowsByEval = new Map<string, RunOutputRow[]>();
  for (const row of listCandidateOutputs(db, run.id, input.candidate_id)) {
    const list = rowsByEval.get(row.eval_id) ?? [];
    list.push(row);
    rowsByEval.set(row.eval_id, list);
  }

  const train = { n_evals: 0, n_pass: 0, n_fail: 0, n_flaky: 0, n_error: 0 };
  const holdout = { n_evals: 0, n_pass: 0, n_fail: 0, n_error: 0 };
  const failing: typeof members = [];
  for (const member of members) {
    const rows = rowsByEval.get(member.eval_id) ?? [];
    const { state, flaky } = evalState(rows);
    const counts = splits.get(member.eval_id) === "holdout" ? holdout : train;
    counts.n_evals += 1;
    if (state === "pass") counts.n_pass += 1;
    if (state === "fail") counts.n_fail += 1;
    if (state === "error") counts.n_error += 1;
    if (counts === train && state === "fail") {
      if (flaky) train.n_flaky += 1;
      failing.push(member);
    }
  }

  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = decodeCursor(input.cursor);
  const page = failing.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < failing.length;

  const failures = page.map((member) => {
    const rows = rowsByEval.get(member.eval_id) ?? [];
    return {
      eval_id: member.eval_id,
      title: member.title,
      input: truncateText(member.input_truncated, INPUT_CHARS),
      archetype_id: member.archetype_id,
      scorer_primitive: member.scorer_primitive,
      flaky: evalState(rows).flaky,
      reps: rows.map((r) => {
        const failed = r.outcome === "scored" && r.passed !== 1;
        const reason = r.outcome === "error" ? `not scored: ${r.reason_short}` : r.reason_short;
        return {
          rep: r.rep,
          passed: r.outcome === "scored" && r.passed === 1,
          reason_short: truncateText(reason, REASON_CHARS),
          output:
            failed && r.output_truncated != null
              ? truncateText(r.output_truncated, OUTPUT_CHARS)
              : null,
        };
      }),
    };
  });

  const output = getTrainingFailuresOutputSchema.parse({
    run_id: run.id,
    candidate_id: input.candidate_id,
    eval_set_id: run.eval_set_id,
    directional,
    train,
    holdout,
    failures,
    next_cursor: hasMore ? String(nextOffset) : null,
    truncated: hasMore,
    next_action: hasMore
      ? {
          tool: "get_training_failures",
          args: {
            project_id: input.project_id,
            run_id: run.id,
            candidate_id: input.candidate_id,
            cursor: String(nextOffset),
          },
          ask_human: null,
        }
      : {
          tool: null,
          args: { run_id: run.id, candidate_id: input.candidate_id, n_train_fail: train.n_fail },
          ask_human: null,
        },
  });
  return { status: 200, body: output };
};
