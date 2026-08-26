import type Database from "better-sqlite3";
import { projectNotFoundError } from "../errors.js";
import { projectExists } from "../keys.js";
import { buildLiveReportUrl } from "../live-report-token.js";
import { CANARY_PERCENT } from "../live/sticky.js";
import { getProjectLiveState } from "../policy.js";
import { buildLiveAutomationReport } from "./live_automation.js";
import {
  countProjectSamples,
  listStoredSamples,
  type SampleRow,
} from "../samples.js";
import type { ToolHandler } from "../dispatch.js";
import {
  getLiveReportOutputSchema,
  type getLiveReportInputSchema,
} from "./schema.js";
import type { z } from "zod";

type ReportInput = z.infer<typeof getLiveReportInputSchema>;

export const LIVE_REPORT_SAMPLE_DEFAULT = 10;
export const LIVE_REPORT_SNIPPET_MAX = 120;

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

function truncateSnippet(text: string, max = LIVE_REPORT_SNIPPET_MAX): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

function lastKnownAgeS(loadedAt: string | null | undefined, nowMs: number): number | null {
  if (typeof loadedAt !== "string" || loadedAt.length === 0) {
    return null;
  }
  const t = Date.parse(loadedAt);
  if (!Number.isFinite(t)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

function mapSample(row: SampleRow) {
  return {
    sample_id: row.id,
    why: row.why as "vendor_error" | "timeout" | "app_reported",
    input_redacted: truncateSnippet(row.input_redacted),
    output_redacted: truncateSnippet(row.output_redacted),
  };
}

export function buildLiveReport(
  db: Database.Database,
  input: ReportInput,
  baseUrl: string,
  apiKey: string,
  nowMs = Date.now(),
): { status: number; body: unknown } {
  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  const state = getProjectLiveState(db, input.project_id);
  const canaryOn =
    Boolean(state?.canary_policy_id) && state?.canary_percent === CANARY_PERCENT;
  const intendedSplit = canaryOn ? CANARY_PERCENT : 0;
  const hashed = state?.hashed_request_count ?? 0;
  const canaryCount = state?.canary_request_count ?? 0;
  const observedSplit = hashed === 0 ? 0 : (canaryCount / hashed) * 100;
  const requests = state?.request_count ?? 0;
  const fallbacks = state?.fallback_count ?? 0;
  const fallbackRate = requests === 0 ? 0 : fallbacks / requests;
  const counts = countProjectSamples(db, input.project_id);
  const limit = input.limit ?? LIVE_REPORT_SAMPLE_DEFAULT;
  const offset = decodeCursor(input.cursor);
  const page = listStoredSamples(db, input.project_id, offset, limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < counts.stored;

  let nextTool: "promote_live_sample" | "compile_policy" | null = null;
  let nextArgs: Record<string, unknown> = {};
  if (counts.stored > 0) {
    nextTool = "promote_live_sample";
    nextArgs = {
      project_id: input.project_id,
      ...(page[0] ? { sample_id: page[0].id } : {}),
    };
  } else if (!state?.last_full_policy_id) {
    nextTool = "compile_policy";
    nextArgs = { project_id: input.project_id };
  }

  const output = getLiveReportOutputSchema.parse({
    policy_id: state?.last_full_policy_id ?? null,
    canary: canaryOn,
    intended_split: intendedSplit,
    observed_split: observedSplit,
    fallback_rate: fallbackRate,
    sample_counts: {
      stored: counts.stored,
      dropped: counts.dropped,
      pii_blocked: state?.pii_blocked_count ?? 0,
    },
    last_known_age_s: lastKnownAgeS(state?.last_known_loaded_at, nowMs),
    samples: page.map(mapSample),
    next_cursor: hasMore ? encodeCursor(nextOffset) : null,
    truncated: hasMore,
    report_url: buildLiveReportUrl(baseUrl, apiKey, input.project_id),
    ...buildLiveAutomationReport(db, input.project_id),
    live_traffic_changed: false,
    next_action: {
      tool: nextTool,
      args: nextArgs,
      ask_human: null,
    },
  });

  return { status: 200, body: output };
}

export const handleGetLiveReport: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("get_live_report requires db on ToolContext");
  }
  const baseUrl = ctx.baseUrl ?? "http://127.0.0.1:3000";
  return buildLiveReport(db, body as ReportInput, baseUrl, ctx.apiKey ?? "");
};
