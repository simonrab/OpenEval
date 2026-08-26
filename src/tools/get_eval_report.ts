import type Database from "better-sqlite3";
import { mapCiExit } from "../ci/exit.js";
import { agentError, projectNotFoundError } from "../errors.js";
import { getEvalSet, listMembers } from "../eval-set.js";
import { projectExists } from "../keys.js";
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
    nextArgs = { project_id: input.project_id };
  } else if (code === ErrorCode.need_new_model) {
    nextTool = "recommend_models";
    nextArgs = {
      project_id: input.project_id,
      eval_set_id: run.eval_set_id,
      run_id: run.id,
      intent: "after_failure",
    };
  } else if (code === ErrorCode.COST_CAP_EXCEEDED) {
    nextTool = "get_eval_report";
    nextArgs = { project_id: input.project_id, run_id: run.id };
  }

  const namedModel = run.named_model
    ? (JSON.parse(run.named_model) as { rec_id: string; model_id: string })
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
      named_model_still_passes: namedModel ? nFail === 0 : null,
      new_failures_missing_from_evals: newFailuresMissing,
      limits_ok: true,
    },
    named_model: namedModel,
    failing_eval_ids: failingEvalIds,
    eval_ids_scored: scoredEvalIds.filter((id) => trustedIds.has(id)),
    eval_ids_not_scored: evalIdsNotScored,
    items: page.map((r) => ({
      eval_id: r.eval_id,
      title: r.title,
      passed: r.passed,
      reason_short: r.reason_short,
    })),
    next_cursor: hasMore ? encodeCursor(nextOffset) : null,
    truncated: hasMore,
    report_url: `${baseUrl}/report?run_id=${encodeURIComponent(run.id)}`,
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

function aggregateResults(
  results: ReturnType<typeof listRunResults>,
  members: ReturnType<typeof listMembers>,
): Array<{
  eval_id: string;
  title: string;
  passed: boolean;
  reason_short: string;
}> {
  const byEval = new Map<
    string,
    { passed: boolean; reason_short: string; title: string }
  >();
  const titleById = new Map(members.map((m) => [m.eval_id, m.title]));

  for (const r of results) {
    const prev = byEval.get(r.eval_id);
    const passed = r.passed === 1;
    if (!prev) {
      byEval.set(r.eval_id, {
        passed,
        reason_short: r.reason_short,
        title: titleById.get(r.eval_id) ?? r.eval_id,
      });
    } else if (!passed) {
      byEval.set(r.eval_id, {
        passed: false,
        reason_short: r.reason_short,
        title: prev.title,
      });
    }
  }

  return [...byEval.entries()].map(([eval_id, v]) => ({
    eval_id,
    title: v.title,
    passed: v.passed,
    reason_short: v.reason_short,
  }));
}

export const handleGetEvalReport: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("get_eval_report requires db on ToolContext");
  }
  const baseUrl = ctx.baseUrl ?? "http://127.0.0.1:3000";
  return buildReport(db, body as ReportInput, baseUrl);
};
