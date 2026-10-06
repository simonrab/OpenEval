import type Database from "better-sqlite3";
import { agentError, needMoreEvalsError, projectNotFoundError, suiteNotFoundError } from "../errors.js";
import {
  getEvalSet,
  getIdempotentResponse,
  listMembers,
  storeIdempotentResponse,
} from "../eval-set.js";
import { newRecId } from "../ids.js";
import { getJobLimits } from "../job.js";
import { deriveWrapKey, projectExists, readSecret } from "../keys.js";
import { buildApproveUrl, signApproveToken } from "../routes/approve.js";
import { buildReportUrl } from "../report-token.js";
import { getRun, listRunResults, OPTIMIZE_INTENT } from "../runner/queue.js";
import { runCandidates } from "../runner/candidates.js";
import { countPersonEvalsNotGraded } from "../runner/score.js";
import { graderAdvice } from "../judge/advice.js";
import { hasEnoughTrustedEvals } from "../runner/worker.js";
import { getOldTrustedEvalIds } from "../eval-set-copy.js";
import { resolveMarkUrlForSet } from "./get_label_status.js";
import {
  aggregateModelStats,
  pickNamedModel,
  type ModelStats,
} from "../rank.js";
import type { CatalogModel } from "../runner/catalog.js";
import type { ToolHandler } from "../dispatch.js";
import {
  recommendModelsOutputSchema,
  type recommendModelsInputSchema,
} from "./schema.js";
import { ErrorCode } from "./types.js";
import type { z } from "zod";

type RecommendInput = z.infer<typeof recommendModelsInputSchema>;

function dropModelsFailingOldEvals(
  stats: ModelStats[],
  oldTrustedEvalIds: string[],
): ModelStats[] {
  if (oldTrustedEvalIds.length === 0) {
    return stats;
  }
  const oldSet = new Set(oldTrustedEvalIds);
  return stats.map((s) => {
    const failsOld = s.failingEvalIds.some((id) => oldSet.has(id));
    if (!failsOld) {
      return s;
    }
    return {
      ...s,
      passedAll: false,
      failingEvalIds: [...new Set([...s.failingEvalIds, ...oldTrustedEvalIds])],
    };
  });
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function storeRecommendation(
  db: Database.Database,
  input: {
    recId: string;
    projectId: string;
    evalSetId: string;
    runId: string;
    intent: string;
    namedModelId: string | null;
    backups: string[];
    quality: { n_pass: number; n_fail: number } & Record<string, unknown>;
    timeMs: { p50: number; p95: number };
    costUsd: number;
    failingEvalIds: string[];
    candidateJson?: string | null;
    backupCandidatesJson?: string | null;
    costSource?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO recommendations
      (id, project_id, eval_set_id, run_id, intent, named_model_id,
       backup_model_ids, quality_json, time_json, cost_usd, failing_eval_ids, created_at,
       candidate_json, backup_candidates_json, cost_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.recId,
    input.projectId,
    input.evalSetId,
    input.runId,
    input.intent,
    input.namedModelId,
    JSON.stringify(input.backups),
    JSON.stringify(input.quality),
    JSON.stringify(input.timeMs),
    input.costUsd,
    JSON.stringify(input.failingEvalIds),
    new Date().toISOString(),
    input.candidateJson ?? null,
    input.backupCandidatesJson ?? null,
    input.costSource ?? null,
  );
}

export const handleRecommendModels: ToolHandler = async (body, ctx) => {
  const db = ctx.db;
  const baseUrl = ctx.baseUrl ?? "http://127.0.0.1:3000";
  if (!db) {
    throw new Error("recommend_models requires db on ToolContext");
  }

  const input = body as RecommendInput;
  const existing = getIdempotentResponse(
    db,
    "recommend_models",
    input.idempotency_key,
  );
  if (existing) {
    return existing;
  }

  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  const evalSet = getEvalSet(db, input.eval_set_id);
  if (!evalSet || evalSet.project_id !== input.project_id) {
    return { status: 404, body: suiteNotFoundError(input.eval_set_id) };
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

  if (!input.run_id) {
    return {
      status: 400,
      body: agentError({
        code: ErrorCode.INVALID_INPUT,
        message: "run_id is required after a finished run",
        retryable: true,
        suggested_tool: "run_evals",
        suggested_args: {
          project_id: input.project_id,
          eval_set_id: input.eval_set_id,
        },
        next_action: {
          tool: "run_evals",
          args: {
            project_id: input.project_id,
            eval_set_id: input.eval_set_id,
          },
          ask_human: null,
        },
      }),
    };
  }

  const run = getRun(db, input.run_id);
  if (!run || run.project_id !== input.project_id) {
    return {
      status: 404,
      body: agentError({
        code: ErrorCode.INVALID_INPUT,
        message: "Run not found",
        retryable: false,
        suggested_tool: null,
        suggested_args: { run_id: input.run_id },
        next_action: { tool: null, args: {}, ask_human: null },
      }),
    };
  }

  if (run.eval_set_id !== input.eval_set_id) {
    return {
      status: 400,
      body: agentError({
        code: ErrorCode.INVALID_INPUT,
        message: "run_id does not match eval_set_id",
        retryable: false,
        suggested_tool: null,
        suggested_args: {},
        next_action: { tool: null, args: {}, ask_human: null },
      }),
    };
  }

  if (run.intent === OPTIMIZE_INTENT) {
    return {
      status: 400,
      body: agentError({
        code: ErrorCode.INVALID_INPUT,
        message:
          "This run scores outputs from an app harness. Use a run from run_evals to name a model.",
        retryable: false,
        suggested_tool: "run_evals",
        suggested_args: { project_id: input.project_id, eval_set_id: input.eval_set_id },
        next_action: {
          tool: "run_evals",
          args: { project_id: input.project_id, eval_set_id: input.eval_set_id },
          ask_human: null,
        },
      }),
    };
  }

  if (run.status === "queued" || run.status === "running") {
    return {
      status: 400,
      body: agentError({
        code: ErrorCode.INVALID_INPUT,
        message: "Run is still in progress",
        retryable: true,
        suggested_tool: "get_eval_report",
        suggested_args: {
          project_id: input.project_id,
          run_id: input.run_id,
        },
        next_action: {
          tool: "get_eval_report",
          args: {
            project_id: input.project_id,
            run_id: input.run_id,
          },
          ask_human: null,
        },
        run_id: input.run_id,
      }),
    };
  }

  if (run.status === "partial" && run.code === ErrorCode.COST_CAP_EXCEEDED) {
    return {
      status: 400,
      body: agentError({
        code: ErrorCode.COST_CAP_EXCEEDED,
        message: "Run stopped at the cost cap; results may be incomplete",
        retryable: true,
        suggested_tool: "get_eval_report",
        suggested_args: {
          project_id: input.project_id,
          run_id: input.run_id,
        },
        next_action: {
          tool: "get_eval_report",
          args: {
            project_id: input.project_id,
            run_id: input.run_id,
          },
          ask_human: null,
        },
        run_id: input.run_id,
      }),
    };
  }

  const trusted = members.filter((m) => m.status === "trusted");
  const trustedEvalIds = trusted.map((m) => m.eval_id);
  const rawResults = listRunResults(db, input.run_id);
  const nNotGraded = countPersonEvalsNotGraded(rawResults);
  const results = rawResults.map((r) => ({
    model_id: r.model_id,
    eval_id: r.eval_id,
    passed: r.passed === 1,
    time_ms: r.time_ms,
    cost_usd: r.cost_usd,
    outcome: r.outcome,
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
    cost_source: r.cost_source,
  }));

  const limits = getJobLimits(db, input.eval_set_id);
  let liveCatalog: CatalogModel[] | undefined;
  if (ctx.openRouter?.listModels && ctx.apiKey && run.keys_ref) {
    try {
      const customerKey = readSecret(
        db,
        deriveWrapKey(ctx.apiKey),
        run.keys_ref,
      );
      liveCatalog = await ctx.openRouter.listModels(customerKey);
    } catch {
      liveCatalog = undefined;
    }
  }
  let stats = aggregateModelStats(results, trustedEvalIds);
  if (input.intent === "add_feature") {
    const oldTrustedEvalIds = getOldTrustedEvalIds(db, input.eval_set_id);
    stats = dropModelsFailingOldEvals(stats, oldTrustedEvalIds);
  }
  if (
    input.intent === "after_failure" &&
    typeof input.current_named_model === "string" &&
    input.current_named_model.length > 0
  ) {
    const current = stats.find((s) => s.modelId === input.current_named_model);
    if (current && !current.passedAll) {
      stats = stats.filter((s) => s.modelId !== input.current_named_model);
    }
  }
  const picked = pickNamedModel(stats, limits, liveCatalog);

  const allTimes = results.map((r) => r.time_ms);
  const totalCost = results.reduce((sum, r) => sum + r.cost_usd, 0);
  const recId = newRecId();

  if (picked.outcome === "does_not_work") {
    storeRecommendation(db, {
      recId,
      projectId: input.project_id,
      evalSetId: input.eval_set_id,
      runId: input.run_id,
      intent: input.intent,
      namedModelId: null,
      backups: [],
      quality: { n_pass: 0, n_fail: picked.failingEvalIds.length },
      timeMs: { p50: percentile(allTimes, 50), p95: percentile(allTimes, 95) },
      costUsd: totalCost,
      failingEvalIds: picked.failingEvalIds,
    });
    const err = agentError({
      code: ErrorCode.does_not_work,
      message: "No model passed the trusted evals inside job limits",
      retryable: false,
      suggested_tool: null,
      suggested_args: {},
      failing_eval_ids: picked.failingEvalIds,
      next_action: {
        tool: null,
        args: {},
        ask_human: "none of the models passed; see failing_eval_ids",
      },
      run_id: input.run_id,
    });
    storeIdempotentResponse(
      db,
      "recommend_models",
      input.idempotency_key,
      400,
      err,
      input.project_id,
    );
    return { status: 400, body: err };
  }

  const winnerRows = results.filter(
    (r) => r.model_id === picked.winner && r.outcome !== "error",
  );
  const winnerTimes = winnerRows.map((r) => r.time_ms);
  const winnerCost = winnerRows.reduce((sum, r) => sum + r.cost_usd, 0);
  const winnerStats = picked.winnerStats;
  const runSetups = run.candidates ? runCandidates(run.models, run.candidates) : [];
  const winnerCandidate = runSetups.find((c) => c.id === picked.winner) ?? null;
  const backupCandidates = picked.backups
    .map((id) => runSetups.find((c) => c.id === id))
    .filter((c) => c !== undefined);
  const quality = {
    n_pass: winnerStats.nPass,
    n_fail: winnerStats.nFail,
    n_trials: winnerStats.nTrials,
    pass_rate: winnerStats.passRate,
    pass_rate_ci95: [winnerStats.passRateLow, winnerStats.passRateHigh] as [number, number],
    flaky_eval_ids: winnerStats.flakyEvalIds,
  };

  storeRecommendation(db, {
    recId,
    projectId: input.project_id,
    evalSetId: input.eval_set_id,
    runId: input.run_id,
    intent: input.intent,
    namedModelId: picked.winner,
    backups: picked.backups,
    quality,
    candidateJson: winnerCandidate ? JSON.stringify(winnerCandidate) : null,
    backupCandidatesJson:
      backupCandidates.length > 0 ? JSON.stringify(backupCandidates) : null,
    costSource: winnerStats.costSource,
    timeMs: {
      p50: percentile(winnerTimes, 50),
      p95: percentile(winnerTimes, 95),
    },
    costUsd: winnerCost,
    failingEvalIds: [],
  });

  const approveUrl = buildApproveUrl(
    baseUrl,
    recId,
    signApproveToken(ctx.apiKey ?? "", recId),
  );
  const output = recommendModelsOutputSchema.parse({
    recommendation_id: recId,
    named_model: {
      id: picked.winner,
      backups: picked.backups,
      ...(winnerCandidate ? { candidate: winnerCandidate } : {}),
    },
    failing_eval_ids: [],
    quality,
    time_ms: {
      p50: percentile(winnerTimes, 50),
      p95: percentile(winnerTimes, 95),
    },
    cost_usd: winnerCost,
    cost_source: winnerStats.costSource as "provider" | "estimate" | "caller" | "mixed",
    n_person_evals_not_graded: nNotGraded,
    grader_advice: graderAdvice(db, input.eval_set_id, nNotGraded),
    report_url: buildReportUrl(baseUrl, ctx.apiKey ?? "", {
      project_id: input.project_id,
      run_id: input.run_id,
    }),
    approve_url: approveUrl,
    next_action: {
      tool: null,
      args: { approve_url: approveUrl },
      ask_human: "open approve_url",
    },
  });

  const result = { status: 200, body: output };
  storeIdempotentResponse(
    db,
    "recommend_models",
    input.idempotency_key,
    200,
    output,
    input.project_id,
  );
  return result;
};
