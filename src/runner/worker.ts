import type Database from "better-sqlite3";
import { deriveWrapKey, readSecret } from "../keys.js";
import { listMembers, type MemberEval } from "../eval-set.js";
import { getJobGoodMeans } from "../mark/store.js";
import { scoreProgramCheck } from "../scoring/index.js";
import { scoreTrustedPersonMark } from "../scoring/person.js";
import { ErrorCode } from "../tools/types.js";
import {
  claimNextRun,
  getRun,
  insertRunResult,
  listRunResults,
  updateRunStatus,
} from "./queue.js";
import type { OpenRouterClient } from "./openrouter.js";
import {
  acquireEvalStart,
  createSpendGate,
  finishEvalSpend,
} from "./spend.js";

export type WorkerOptions = {
  db: Database.Database;
  apiKey: string;
  openRouter: OpenRouterClient;
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

function trustedCodeEvals(members: MemberEval[]): MemberEval[] {
  return members.filter(
    (m) =>
      m.status === "trusted" &&
      m.score_how === "code" &&
      m.program_check != null,
  );
}

function trustedPersonEvals(db: Database.Database, members: MemberEval[]): Array<
  MemberEval & { trusted_mark: string }
> {
  const out: Array<MemberEval & { trusted_mark: string }> = [];
  for (const m of members) {
    if (m.status !== "trusted" || m.score_how !== "person") {
      continue;
    }
    const row = db
      .prepare(`SELECT trusted_mark FROM evals WHERE id = ?`)
      .get(m.eval_id) as { trusted_mark: string | null } | undefined;
    if (row?.trusted_mark) {
      out.push({ ...m, trusted_mark: row.trusted_mark });
    }
  }
  return out;
}

function evalsForRun(
  db: Database.Database,
  members: MemberEval[],
): Array<
  | (MemberEval & { kind: "code" })
  | (MemberEval & { kind: "person"; trusted_mark: string })
> {
  const code = trustedCodeEvals(members).map((m) => ({ ...m, kind: "code" as const }));
  const person = trustedPersonEvals(db, members).map((m) => ({
    ...m,
    kind: "person" as const,
  }));
  return [...code, ...person];
}

export async function processRun(opts: WorkerOptions, runId: string): Promise<void> {
  const run = getRun(opts.db, runId);
  if (!run) {
    return;
  }

  const models = JSON.parse(run.models) as string[];
  const members = listMembers(opts.db, run.eval_set_id);
  const evals = evalsForRun(opts.db, members);
  const mustNever = getJobGoodMeans(opts.db, run.eval_set_id)?.must_never;
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

  const runModel = async (modelId: string): Promise<void> => {
    for (const ev of evals) {
      const started = await acquireEvalStart(gate);
      if (!started) {
        capHit = true;
        return;
      }

      let content: string;
      let timeMs: number;
      let costUsd: number;
      try {
        const result = await opts.openRouter.chatCompletion({
          model: modelId,
          prompt: ev.input_truncated,
          apiKey: customerKey,
        });
        content = result.content;
        timeMs = result.time_ms;
        costUsd = result.cost_usd;
      } catch (err) {
        await finishEvalSpend(gate, 0);
        insertRunResult(opts.db, {
          runId,
          evalId: ev.eval_id,
          modelId,
          passed: false,
          reasonShort: modelFailureReason(err),
          timeMs: 0,
          costUsd: 0,
        });
        continue;
      }

      await finishEvalSpend(gate, costUsd);
      let scored: { passed: boolean; reason_short: string };
      if (ev.kind === "code") {
        scored = scoreProgramCheck(content, ev.program_check!);
      } else {
        scored = scoreTrustedPersonMark(content, ev.trusted_mark, mustNever);
      }
      insertRunResult(opts.db, {
        runId,
        evalId: ev.eval_id,
        modelId,
        passed: scored.passed,
        reasonShort: scored.reason_short,
        timeMs,
        costUsd,
      });

      if (gate.exceeded) {
        capHit = true;
        return;
      }
    }
  };

  await Promise.all(models.map((modelId) => runModel(modelId)));

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
  const results = listRunResults(db, runId).filter((r) => r.model_id === modelId);
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
