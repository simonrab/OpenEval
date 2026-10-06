import type Database from "better-sqlite3";
import { mapCiExit } from "../ci/exit.js";
import { agentError, projectNotFoundError } from "../errors.js";
import { getEvalSet, listMembers } from "../eval-set.js";
import { projectExists } from "../keys.js";
import { buildReportUrl } from "../report-token.js";
import { getRun, listRunResults } from "../runner/queue.js";
import { countPersonEvalsNotGraded } from "../runner/score.js";
import { graderAdvice } from "../judge/advice.js";
import { aggregateModelStats } from "../rank.js";
import { ensureEvalSplit } from "../splits.js";
import { isOptimizerScope } from "./scope.js";
import type { ToolHandler } from "../dispatch.js";
import {
  getEvalReportOutputSchema,
  type getEvalReportInputSchema,
} from "./schema.js";
import { ErrorCode } from "./types.js";
import type { z } from "zod";

type ReportInput = z.infer<typeof getEvalReportInputSchema>;

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) {
    return 0;
  }
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function encodeCursor(offset: number): string {
  return String(offset);
}

function truncateReason(reason: string, max = 240): string {
  return reason.length > max ? `${reason.slice(0, max - 3)}...` : reason;
}

function checkNewFailuresMissing(
  run: { new_failures: string | null },
  members: Array<{ input_truncated: string }>,
): boolean {
  if (!run.new_failures) {
    return false;
  }
  const failures = JSON.parse(run.new_failures) as Array<{
    input: { prompt: string };
  }>;
  const prompts = new Set(members.map((m) => m.input_truncated));
  return failures.some((f) => !prompts.has(f.input.prompt));
}

export function buildReport(
  db: Database.Database,
  input: ReportInput,
  baseUrl: string,
  apiKey: string,
  opts: { redactHoldout?: boolean } = {},
): { status: number; body: unknown } {
  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  if (!input.run_id) {
    return {
      status: 501,
      body: agentError({
        code: ErrorCode.NOT_BUILT,
        message: "Report by recommendation_id or eval_set_id is not built yet",
        retryable: false,
        suggested_tool: "get_eval_report",
        suggested_args: {},
        next_action: { tool: null, args: {}, ask_human: null },
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

  const members = listMembers(db, run.eval_set_id);
  const trusted = members.filter((m) => m.status === "trusted");
  const trustedIds = new Set(trusted.map((m) => m.eval_id));
  const allResults = listRunResults(db, run.id);
  // Calls that failed after retries are not scored. They are not quality fails.
  const results = allResults.filter((r) => r.outcome !== "error");

  const limit = input.limit ?? 20;
  const offset = decodeCursor(input.cursor);
  const modelIds = parseRunModels(run.models, allResults);
  const statsById = new Map(
    aggregateModelStats(
      allResults.map((r) => ({
        model_id: r.model_id,
        eval_id: r.eval_id,
        passed: r.passed === 1,
        time_ms: r.time_ms,
        cost_usd: r.cost_usd,
        outcome: r.outcome,
        prompt_tokens: r.prompt_tokens,
        completion_tokens: r.completion_tokens,
        cost_source: r.cost_source,
      })),
      trusted.map((m) => m.eval_id),
    ).map((s) => [s.modelId, s]),
  );
  const modelSummaries = summarizeModelResults(
    results,
    trusted.map((m) => m.eval_id),
    modelIds,
  ).map((summary) => {
    const stats = statsById.get(summary.model_id);
    if (!stats) {
      return summary;
    }
    return {
      ...summary,
      n_trials: stats.nTrials,
      pass_rate: stats.passRate,
      pass_rate_ci95: [stats.passRateLow, stats.passRateHigh] as [number, number],
      flaky_eval_ids: stats.flakyEvalIds,
      error_eval_ids: stats.errorEvalIds,
      cost_usd: stats.totalCostUsd,
      cost_source: stats.costSource as "provider" | "estimate" | "caller" | "mixed",
      spend_per_1k_tokens_usd: stats.spendPer1kUsd,
    };
  });
  const aggregated = aggregateResults(results, members);
  // Items also list evals that have only error rows, so the agent sees why.
  const scoredSet = new Set(results.map((r) => r.eval_id));
  const itemRows = allResults
    .filter((r) => r.outcome !== "error" || !scoredSet.has(r.eval_id))
    .map((r) =>
      r.outcome === "error"
        ? { ...r, reason_short: `not scored: ${r.reason_short}` }
        : r,
    );
  // An optimizer key sees train evals only. Holdout shows as counts.
  const split = opts.redactHoldout ? ensureEvalSplit(db, run.eval_set_id).splits : null;
  const shown = (id: string) => !split || split.get(id) === "train";
  const items = aggregateResults(itemRows, members).filter((r) => shown(r.eval_id));
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < items.length;

  const holdoutRedacted = split
    ? (() => {
        const held = [...split].filter(([, s]) => s === "holdout").map(([id]) => id);
        const rows = aggregated.filter((r) => held.includes(r.eval_id));
        return {
          n_evals: held.length,
          n_pass: rows.filter((r) => r.passed).length,
          n_fail: rows.filter((r) => !r.passed).length,
        };
      })()
    : undefined;

  const nPass = aggregated.filter((r) => r.passed).length;
  const nFail = aggregated.filter((r) => !r.passed).length;
  const times = results.map((r) => r.time_ms);
  const costUsd = run.spend_usd;

  const scoredEvalIds = [...new Set(results.map((r) => r.eval_id))];
  const evalIdsNotScored = trusted
    .filter((m) => !scoredEvalIds.includes(m.eval_id))
    .map((m) => m.eval_id);

  const newFailuresMissing = checkNewFailuresMissing(run, members);
  const nNotGraded = countPersonEvalsNotGraded(results);

  const failingEvalIds = [
    ...new Set(aggregated.filter((r) => !r.passed).map((r) => r.eval_id)),
  ];

  const runStatus = run.status as
    | "queued"
    | "running"
    | "succeeded"
    | "partial"
    | "failed";

  let code: string | null = run.code;
  if (newFailuresMissing) {
    code = ErrorCode.evals_missing_new_failures;
  } else if (
    run.intent === "recheck" &&
    runStatus !== "queued" &&
    runStatus !== "running" &&
    runStatus !== "partial" &&
    runStatus !== "failed" &&
    nFail > 0 &&
    code == null
  ) {
    code = ErrorCode.need_new_model;
  }

  const ciExit = mapCiExit({
    status: runStatus,
    code,
    summary: {
      n_fail: nFail,
      new_failures_missing_from_evals: newFailuresMissing,
    },
    eval_ids_not_scored: evalIdsNotScored,
  });

  const namedModel = run.named_model
    ? (JSON.parse(run.named_model) as { rec_id: string; model_id: string })
    : null;

  let nextTool: string | null = "recommend_models";
  let nextArgs: Record<string, unknown> = {
    project_id: input.project_id,
    eval_set_id: run.eval_set_id,
    run_id: run.id,
  };
  if (runStatus === "queued" || runStatus === "running") {
    nextTool = "get_eval_report";
    nextArgs = { project_id: input.project_id, run_id: run.id };
  } else if (run.intent === "recheck" && code == null && runStatus === "succeeded") {
    nextTool = null;
    nextArgs = {};
  } else if (code === ErrorCode.evals_missing_new_failures) {
    nextTool = "register_failure";
    nextArgs = {
      project_id: input.project_id,
      eval_set_id: run.eval_set_id,
    };
  } else if (code === ErrorCode.need_new_model) {
    nextTool = "recommend_models";
    nextArgs = {
      project_id: input.project_id,
      eval_set_id: run.eval_set_id,
      run_id: run.id,
      intent: "after_failure",
      current_named_model: namedModel?.model_id ?? null,
    };
  } else if (code === ErrorCode.COST_CAP_EXCEEDED) {
    nextTool = "get_eval_report";
    nextArgs = { project_id: input.project_id, run_id: run.id };
  }
  const namedModelSummary = namedModel
    ? modelSummaries.find((m) => m.model_id === namedModel.model_id)
    : null;
  const namedModelStillPasses = namedModel
    ? namedModelSummary != null &&
      namedModelSummary.n_fail === 0 &&
      namedModelSummary.n_pass === trusted.length
    : null;

  if (split && (nextTool === "recommend_models" || nextTool === "register_failure")) {
    nextTool = "get_training_failures";
    nextArgs = { project_id: input.project_id, run_id: run.id, candidate_id: modelIds[0] ?? "" };
  }

  const output = getEvalReportOutputSchema.parse({
    status: runStatus,
    code,
    summary: {
      run_id: run.id,
      eval_set_id: run.eval_set_id,
      eval_set_version: run.eval_set_version,
      n_pass: nPass,
      n_fail: nFail,
      time_ms: { p50: percentile(times, 50), p95: percentile(times, 95) },
      cost_usd: costUsd,
      named_model_still_passes: namedModelStillPasses,
      new_failures_missing_from_evals: newFailuresMissing,
      limits_ok: true,
      n_person_evals_not_graded: nNotGraded,
      grader_advice: graderAdvice(db, run.eval_set_id, nNotGraded),
    },
    named_model: namedModel,
    failing_eval_ids: failingEvalIds.filter(shown),
    eval_ids_scored: scoredEvalIds.filter((id) => trustedIds.has(id) && shown(id)),
    eval_ids_not_scored: evalIdsNotScored.filter(shown),
    models: split
      ? modelSummaries.map((m) => ({
          ...m,
          failing_eval_ids: m.failing_eval_ids.filter(shown),
          ...("flaky_eval_ids" in m ? { flaky_eval_ids: m.flaky_eval_ids.filter(shown) } : {}),
          ...("error_eval_ids" in m ? { error_eval_ids: m.error_eval_ids.filter(shown) } : {}),
        }))
      : modelSummaries,
    items: page.map((r) => ({
      eval_id: r.eval_id,
      title: r.title,
      passed: r.passed,
      reason_short: r.reason_short,
      archetype_id: r.archetype_id,
      scorer_primitive: r.scorer_primitive,
    })),
    next_cursor: hasMore ? encodeCursor(nextOffset) : null,
    truncated: hasMore,
    report_url: split
      ? null
      : buildReportUrl(baseUrl, apiKey, {
          project_id: input.project_id,
          run_id: run.id,
        }),
    ...(holdoutRedacted ? { holdout_redacted: holdoutRedacted } : {}),
    live_traffic_changed: false,
    ci_exit: ciExit,
    next_action: {
      tool: nextTool,
      args: nextArgs,
      ask_human: null,
    },
  });

  return { status: 200, body: output };
}

function parseRunModels(
  raw: string,
  results: ReturnType<typeof listRunResults>,
): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const modelIds = parsed.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (modelIds.length > 0) {
        return [...new Set(modelIds)];
      }
    }
  } catch {
    // Fall through to results.
  }
  return [...new Set(results.map((r) => r.model_id))];
}

function summarizeModelResults(
  results: ReturnType<typeof listRunResults>,
  trustedEvalIds: string[],
  modelIds: string[],
): Array<{
  model_id: string;
  n_pass: number;
  n_fail: number;
  failing_eval_ids: string[];
}> {
  const trustedSet = new Set(trustedEvalIds);
  return modelIds.map((modelId) => {
    const rows = results.filter(
      (r) => r.model_id === modelId && trustedSet.has(r.eval_id),
    );
    // An eval passes only when every rep passes.
    const failedIds = new Set(
      rows.filter((r) => r.passed !== 1).map((r) => r.eval_id),
    );
    const passedIds = new Set(
      rows
        .filter((r) => r.passed === 1 && !failedIds.has(r.eval_id))
        .map((r) => r.eval_id),
    );
    for (const evalId of trustedEvalIds) {
      if (!passedIds.has(evalId) && !failedIds.has(evalId)) {
        failedIds.add(evalId);
      }
    }
    return {
      model_id: modelId,
      n_pass: passedIds.size,
      n_fail: failedIds.size,
      failing_eval_ids: [...failedIds],
    };
  });
}

function aggregateResults(
  results: ReturnType<typeof listRunResults>,
  members: ReturnType<typeof listMembers>,
): Array<{
  eval_id: string;
  title: string;
  passed: boolean;
  reason_short: string;
  archetype_id: string | null;
  scorer_primitive: string | null;
}> {
  const byEval = new Map<string, ReturnType<typeof listRunResults>>();
  const titleById = new Map(members.map((m) => [m.eval_id, m.title]));

  for (const r of results) {
    if (!titleById.has(r.eval_id)) {
      continue;
    }
    const rows = byEval.get(r.eval_id) ?? [];
    rows.push(r);
    byEval.set(r.eval_id, rows);
  }

  const out: Array<{
    eval_id: string;
    title: string;
    passed: boolean;
    reason_short: string;
    archetype_id: string | null;
    scorer_primitive: string | null;
  }> = [];
  for (const member of members) {
    const rows = byEval.get(member.eval_id);
    if (!rows || rows.length === 0) {
      continue;
    }
    // A model passes an eval only when every rep passes.
    const failedModels = new Set(
      rows.filter((r) => r.passed !== 1).map((r) => r.model_id),
    );
    const passedRows = rows.filter(
      (r, i) =>
        r.passed === 1 &&
        !failedModels.has(r.model_id) &&
        rows.findIndex((o) => o.model_id === r.model_id) === i,
    );
    if (passedRows.length > 0) {
      const reason =
        failedModels.size === 0
          ? passedRows[0]!.reason_short
          : `passed by ${passedRows.map((r) => r.model_id).join(", ")}; ${
              failedModels.size
            } model ${failedModels.size === 1 ? "miss" : "misses"}`;
      out.push({
        eval_id: member.eval_id,
        title: member.title,
        passed: true,
        reason_short: truncateReason(reason),
        archetype_id: member.archetype_id,
        scorer_primitive: member.scorer_primitive,
      });
      continue;
    }
    out.push({
      eval_id: member.eval_id,
      title: member.title,
      passed: false,
      reason_short: truncateReason(rows[0]!.reason_short),
      archetype_id: member.archetype_id,
      scorer_primitive: member.scorer_primitive,
    });
  }
  return out;
}

export const handleGetEvalReport: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("get_eval_report requires db on ToolContext");
  }
  const baseUrl = ctx.baseUrl ?? "http://127.0.0.1:3000";
  return buildReport(db, body as ReportInput, baseUrl, ctx.apiKey ?? "", {
    redactHoldout: isOptimizerScope(ctx),
  });
};
