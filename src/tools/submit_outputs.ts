import type { z } from "zod";
import type { ToolHandler } from "../dispatch.js";
import { agentError, projectNotFoundError, suiteNotFoundError } from "../errors.js";
import {
  getEvalSet,
  getIdempotentResponse,
  listMembers,
  storeIdempotentResponse,
} from "../eval-set.js";
import { newRunId } from "../ids.js";
import { deriveWrapKey, missingKeysRefError, projectExists, readSecret } from "../keys.js";
import { trustedJudgeFn } from "../judge/runner.js";
import { getJobGoodMeans } from "../mark/store.js";
import { baseModelId } from "../runner/candidates.js";
import { insertRunResult, OPTIMIZE_INTENT } from "../runner/queue.js";
import {
  countPersonEvalsNotGraded,
  scorableEvals,
  scoreOutput,
  type JudgeFn,
  type ScoreOutcome,
} from "../runner/score.js";
import { graderAdvice } from "../judge/advice.js";
import { createSpendGate } from "../runner/spend.js";
import { truncateText } from "./referee.js";
import {
  submitOutputsOutputSchema,
  type submitOutputsInputSchema,
} from "./schema.js";
import { ErrorCode } from "./types.js";

type Input = z.infer<typeof submitOutputsInputSchema>;

const REASON_CHARS = 240;
const JUDGE_CONCURRENCY = 4;

/** Run fn over items with a small worker pool. Results keep input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  return out;
}

function badOutputsError(input: Input, message: string) {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message,
    retryable: true,
    suggested_tool: "get_eval_inputs",
    suggested_args: { project_id: input.project_id, eval_set_id: input.eval_set_id },
    next_action: {
      tool: "get_eval_inputs",
      args: { project_id: input.project_id, eval_set_id: input.eval_set_id },
      ask_human: null,
    },
  });
}

/**
 * Score outputs that the app harness made. The run is done when this returns.
 * The result has counts only, so holdout pass and fail stay hidden.
 */
export const handleSubmitOutputs: ToolHandler = async (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("submit_outputs requires db on ToolContext");
  }
  const input = body as Input;
  const cached = getIdempotentResponse(db, "submit_outputs", input.idempotency_key);
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

  const evals = new Map(
    scorableEvals(db, listMembers(db, input.eval_set_id)).map((ev) => [ev.eval_id, ev]),
  );
  const seen = new Set<string>();
  for (const out of input.outputs) {
    if (!evals.has(out.eval_id)) {
      return {
        status: 400,
        body: badOutputsError(
          input,
          `The eval set has no trusted eval ${out.eval_id}. Use the eval ids from get_eval_inputs.`,
        ),
      };
    }
    const key = `${out.eval_id}:${out.rep ?? 0}`;
    if (seen.has(key)) {
      return {
        status: 400,
        body: badOutputsError(
          input,
          `Eval ${out.eval_id} has two outputs for rep ${out.rep ?? 0}. Send one output for each rep.`,
        ),
      };
    }
    seen.add(key);
  }

  const mustNever = getJobGoodMeans(db, input.eval_set_id)?.must_never;
  const gate = createSpendGate(input.max_eval_spend_usd ?? 0);
  let judge: JudgeFn | null = null;
  const hasPerson = input.outputs.some(
    (o) => o.output !== undefined && evals.get(o.eval_id)!.kind === "person",
  );
  if (input.keys_ref && hasPerson && ctx.openRouter) {
    let customerKey: string;
    try {
      customerKey = readSecret(db, deriveWrapKey(ctx.apiKey ?? ""), input.keys_ref);
    } catch {
      return { status: 400, body: missingKeysRefError(input.project_id) };
    }
    judge = trustedJudgeFn(db, input.eval_set_id, {
      client: ctx.openRouter,
      apiKey: customerKey,
      gate,
    });
  }
  const scores: Array<ScoreOutcome | null> = await mapPool(
    input.outputs,
    JUDGE_CONCURRENCY,
    (out) =>
      out.output === undefined
        ? Promise.resolve(null)
        : scoreOutput(evals.get(out.eval_id)!, out.output, { mustNever, judge }),
  );
  const judgeSpend = gate.spent;
  const candidate = input.candidate;
  const runId = newRunId();
  const now = new Date().toISOString();
  const reps = Math.max(...input.outputs.map((o) => (o.rep ?? 0) + 1));
  const storedCandidate = {
    id: candidate.id,
    model: baseModelId(candidate.id),
    harness: true,
    ...(candidate.label ? { label: candidate.label } : {}),
    ...(candidate.description ? { description: candidate.description } : {}),
    ...(candidate.commit ? { commit: candidate.commit } : {}),
  };

  const output = db.transaction(() => {
    db.prepare(
      `INSERT INTO runs
        (id, project_id, eval_set_id, eval_set_version, status, code, models,
         max_eval_spend_usd, keys_ref, intent, named_model, new_failures,
         spend_usd, idempotency_key, created_at, updated_at, reps, candidates)
       VALUES (?, ?, ?, ?, 'running', NULL, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      input.project_id,
      input.eval_set_id,
      evalSet.version,
      JSON.stringify([candidate.id]),
      input.max_eval_spend_usd ?? 0,
      input.keys_ref ?? null,
      OPTIMIZE_INTENT,
      input.idempotency_key,
      now,
      now,
      reps,
      JSON.stringify([storedCandidate]),
    );

    let nScored = 0;
    let nError = 0;
    let spend = judgeSpend;
    const covered = new Set<string>();
    for (const [i, out] of input.outputs.entries()) {
      const ev = evals.get(out.eval_id)!;
      const costUsd = out.cost_usd ?? 0;
      spend += costUsd;
      covered.add(out.eval_id);
      const common = {
        runId,
        evalId: out.eval_id,
        modelId: candidate.id,
        rep: out.rep ?? 0,
        timeMs: out.time_ms ?? 0,
        costUsd,
        costSource: "caller",
        promptTokens: out.prompt_tokens ?? null,
        completionTokens: out.completion_tokens ?? null,
        servedModel: out.served_model ?? null,
      };
      if (out.error !== undefined) {
        nError += 1;
        insertRunResult(db, {
          ...common,
          passed: false,
          outcome: "error",
          reasonShort: truncateText(`harness error: ${out.error}`, REASON_CHARS),
        });
        continue;
      }
      const scored = scores[i]!;
      if (scored.error) {
        nError += 1;
      } else {
        nScored += 1;
      }
      insertRunResult(db, {
        ...common,
        passed: scored.passed,
        outcome: scored.error ? "error" : "scored",
        reasonShort: scored.reason_short,
        output: out.output!,
        judgeCostUsd: judge && ev.kind === "person" ? scored.judge_cost_usd : null,
      });
    }

    const nNotGraded = countPersonEvalsNotGraded(
      input.outputs.flatMap((out, i) => {
        const sc = scores[i];
        return sc && !sc.error ? [{ eval_id: out.eval_id, reason_short: sc.reason_short }] : [];
      }),
    );
    db.prepare(
      `UPDATE runs SET status = 'succeeded', spend_usd = ?, updated_at = ? WHERE id = ?`,
    ).run(spend, new Date().toISOString(), runId);

    const result = submitOutputsOutputSchema.parse({
      run_id: runId,
      candidate_id: candidate.id,
      eval_set_id: input.eval_set_id,
      n_scored: nScored,
      n_error: nError,
      n_not_scored: [...evals.keys()].filter((id) => !covered.has(id)).length,
      n_person_evals_not_graded: nNotGraded,
      grader_advice: graderAdvice(db, input.eval_set_id, nNotGraded),
      next_action: {
        tool: "get_verdict",
        args: {
          project_id: input.project_id,
          candidate_run_id: runId,
          candidate_id: candidate.id,
        },
        ask_human: null,
      },
    });
    storeIdempotentResponse(
      db,
      "submit_outputs",
      input.idempotency_key,
      200,
      result,
      input.project_id,
    );
    return result;
  })();
  return { status: 200, body: output };
};
