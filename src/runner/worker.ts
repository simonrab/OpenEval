import type Database from "better-sqlite3";
import { deriveWrapKey, readSecret } from "../keys.js";
import { listMembers, type MemberEval } from "../eval-set.js";
import { scorableEvals, scoreOutput } from "./score.js";
import { trustedJudgeFn } from "../judge/runner.js";
import { getJobGoodMeans } from "../mark/store.js";
import { getJobSystemPrompt } from "../job.js";
import { ErrorCode } from "../tools/types.js";
import {
  claimNextRun,
  getRun,
  insertRunResult,
  listRunResults,
  updateRunStatus,
} from "./queue.js";
import type { OpenRouterClient } from "./openrouter.js";
import { runCandidates } from "./candidates.js";
import { withRetries, type RetryOptions } from "./retry.js";
import {
  acquireEvalStart,
  createSpendGate,
  finishEvalSpend,
} from "./spend.js";

export type WorkerOptions = {
  db: Database.Database;
  apiKey: string;
  openRouter: OpenRouterClient;
  retry?: RetryOptions;
};

const MODEL_CALL_FAILED = "model call failed";
const MAX_MODEL_FAILURE_REASON_CHARS = 240;

export function startWorker(opts: WorkerOptions): () => void {
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) {
      if (!stopped) {
        setImmediate(tick);
      }
      return;
    }
    const runId = claimNextRun(opts.db);
    if (!runId) {
      setImmediate(tick);
      return;
    }
    busy = true;
    try {
      await processRun(opts, runId);
    } catch (err) {
      console.error("worker error", runId, err);
      updateRunStatus(opts.db, runId, "failed", null, 0);
    } finally {
      busy = false;
      if (!stopped) {
        setImmediate(tick);
      }
    }
  };

  setImmediate(tick);
  return () => {
    stopped = true;
  };
}

export async function processRun(opts: WorkerOptions, runId: string): Promise<void> {
  const run = getRun(opts.db, runId);
  if (!run) {
    return;
  }

  const candidates = runCandidates(run.models, run.candidates);
  const reps = Math.max(1, run.reps ?? 1);
  const members = listMembers(opts.db, run.eval_set_id);
  const evals = scorableEvals(opts.db, members);
  const mustNever = getJobGoodMeans(opts.db, run.eval_set_id)?.must_never;
  const systemPrompt = getJobSystemPrompt(opts.db, run.eval_set_id) ?? undefined;
  const wrapKey = deriveWrapKey(opts.apiKey);
  let customerKey: string;
  if (!run.keys_ref) {
    updateRunStatus(opts.db, runId, "failed", null, 0);
    return;
  }
  try {
    customerKey = readSecret(opts.db, wrapKey, run.keys_ref);
  } catch {
    updateRunStatus(opts.db, runId, "failed", null, 0);
    return;
  }

  const gate = createSpendGate(run.max_eval_spend_usd);
  let capHit = false;
  const hasPersonEvals = evals.some((ev) => ev.kind === "person");
  const judge = hasPersonEvals
    ? trustedJudgeFn(opts.db, run.eval_set_id, {
        client: opts.openRouter,
        apiKey: customerKey,
        gate,
        retry: opts.retry,
      })
    : null;

  const runCandidate = async (candidate: (typeof candidates)[number]): Promise<void> => {
    const modelId = candidate.id;
    for (const ev of evals) {
      for (let rep = 0; rep < reps; rep += 1) {
        const started = await acquireEvalStart(gate);
        if (!started) {
          capHit = true;
          return;
        }

        const call = await withRetries(
          () =>
            opts.openRouter.chatCompletion({
              model: candidate.model,
              prompt: ev.input_truncated,
              apiKey: customerKey,
              systemPrompt: candidate.system_prompt ?? systemPrompt,
              settings: candidate.settings,
            }),
          opts.retry,
        );
        if (!call.ok) {
          await finishEvalSpend(gate, 0);
          insertRunResult(opts.db, {
            runId,
            evalId: ev.eval_id,
            modelId,
            rep,
            passed: false,
            outcome: "error",
            reasonShort: modelFailureReason(call.error),
            timeMs: 0,
            costUsd: 0,
            attempts: call.attempts,
          });
          continue;
        }

        const result = call.value;
        await finishEvalSpend(gate, result.cost_usd);
        const scored = await scoreOutput(ev, result.content, { mustNever, judge });
        if (scored.cap_hit) {
          capHit = true;
        }
        insertRunResult(opts.db, {
          runId,
          evalId: ev.eval_id,
          modelId,
          rep,
          passed: scored.passed,
          outcome: scored.error ? "error" : "scored",
          reasonShort: scored.reason_short,
          judgeCostUsd: judge && ev.kind === "person" ? scored.judge_cost_usd : null,
          timeMs: result.time_ms,
          costUsd: result.cost_usd,
          costSource: result.cost_source ?? null,
          promptTokens: result.prompt_tokens ?? null,
          completionTokens: result.completion_tokens ?? null,
          servedModel: result.served_model ?? null,
          attempts: call.attempts,
          output: result.content,
        });

        if (gate.exceeded || scored.cap_hit) {
          capHit = true;
          return;
        }
      }
    }
  };

  await Promise.all(candidates.map((candidate) => runCandidate(candidate)));

  if (capHit) {
    updateRunStatus(
      opts.db,
      runId,
      "partial",
      ErrorCode.COST_CAP_EXCEEDED,
      gate.spent,
    );
    return;
  }

  if (run.intent === "recheck" && run.named_model) {
    const named = JSON.parse(run.named_model) as { model_id: string };
    const code = recheckResultCode(
      opts.db,
      runId,
      named.model_id,
      evals.map((e) => e.eval_id),
    );
    updateRunStatus(opts.db, runId, "succeeded", code, gate.spent);
    return;
  }

  updateRunStatus(opts.db, runId, "succeeded", null, gate.spent);
}

function recheckResultCode(
  db: Database.Database,
  runId: string,
  modelId: string,
  trustedEvalIds: string[],
): string | null {
  // Error rows are not scored. They do not count as a quality fail.
  const results = listRunResults(db, runId).filter(
    (r) => r.model_id === modelId && r.outcome === "scored",
  );
  const scoredIds = new Set(results.map((r) => r.eval_id));
  const notScored = trustedEvalIds.filter((id) => !scoredIds.has(id));
  if (notScored.length > 0) {
    return null;
  }
  const anyFail = results.some((r) => r.passed !== 1);
  return anyFail ? ErrorCode.need_new_model : null;
}

export function hasEnoughTrustedEvals(members: MemberEval[]): boolean {
  const trusted = members.filter((m) => m.status === "trusted");
  if (trusted.length >= 10) {
    return true;
  }
  const codeTrusted = trusted.filter((m) => m.score_how === "code");
  if (codeTrusted.length >= 5 && codeTrusted.length === trusted.length) {
    return true;
  }
  return false;
}

export function countTrustedCodeEvals(members: MemberEval[]): number {
  return members.filter(
    (m) => m.status === "trusted" && m.score_how === "code",
  ).length;
}

function modelFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (!/^OpenRouter \d{3}:/.test(message)) {
    return MODEL_CALL_FAILED;
  }

  const sanitized = message
    .replace(/\s+/g, " ")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .trim();

  return (
    sanitized.slice(0, MAX_MODEL_FAILURE_REASON_CHARS) || MODEL_CALL_FAILED
  );
}
