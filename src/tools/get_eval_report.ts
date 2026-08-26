import type Database from "better-sqlite3";
import { mapCiExit } from "../ci/exit.js";
import { agentError, projectNotFoundError } from "../errors.js";
import { getEvalSet, listMembers } from "../eval-set.js";
import { projectExists } from "../keys.js";
import { buildReportUrl } from "../report-token.js";
import { getRun, listRunResults } from "../runner/queue.js";
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
  const results = listRunResults(db, run.id);

  const limit = input.limit ?? 20;
  const offset = decodeCursor(input.cursor);
  const modelIds = parseRunModels(run.models, results);
  const modelSummaries = summarizeModelResults(
    results,
    trusted.map((m) => m.eval_id),
    modelIds,
  );
  const aggregated = aggregateResults(results, members);
  const page = aggregated.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < aggregated.length;

  const nPass = aggregated.filter((r) => r.passed).length;
  const nFail = aggregated.filter((r) => !r.passed).length;
  const times = results.map((r) => r.time_ms);
  const costUsd = run.spend_usd;

  const scoredEvalIds = [...new Set(results.map((r) => r.eval_id))];
  const evalIdsNotScored = trusted
    .filter((m) => !scoredEvalIds.includes(m.eval_id))
    .map((m) => m.eval_id);

  const newFailuresMissing = checkNewFailuresMissing(run, members);

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
    },
    named_model: namedModel,
    failing_eval_ids: failingEvalIds,
    eval_ids_scored: scoredEvalIds.filter((id) => trustedIds.has(id)),
    eval_ids_not_scored: evalIdsNotScored,
    models: modelSummaries,
    items: page.map((r) => ({
      eval_id: r.eval_id,
      title: r.title,
      passed: r.passed,
      reason_short: r.reason_short,
    })),
    next_cursor: hasMore ? encodeCursor(nextOffset) : null,
    truncated: hasMore,
    report_url: buildReportUrl(baseUrl, apiKey, {
      project_id: input.project_id,
      run_id: run.id,
    }),
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
    const passedIds = new Set(
      rows.filter((r) => r.passed === 1).map((r) => r.eval_id),
    );
    const failedIds = new Set(
      rows.filter((r) => r.passed !== 1).map((r) => r.eval_id),
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
  }> = [];
  for (const member of members) {
    const rows = byEval.get(member.eval_id);
    if (!rows || rows.length === 0) {
      continue;
    }
    const passedRows = rows.filter((r) => r.passed === 1);
    if (passedRows.length > 0) {
      const failedRows = rows.filter((r) => r.passed !== 1);
      const reason =
        failedRows.length === 0
          ? passedRows[0]!.reason_short
          : `passed by ${passedRows.map((r) => r.model_id).join(", ")}; ${
              failedRows.length
            } model ${failedRows.length === 1 ? "miss" : "misses"}`;
      out.push({
        eval_id: member.eval_id,
        title: member.title,
        passed: true,
        reason_short: truncateReason(reason),
      });
      continue;
    }
    out.push({
      eval_id: member.eval_id,
      title: member.title,
      passed: false,
      reason_short: truncateReason(rows[0]!.reason_short),
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
  return buildReport(db, body as ReportInput, baseUrl, ctx.apiKey ?? "");
};
