import type Database from "better-sqlite3";
import {
  recNotApprovedError,
  projectNotFoundError,
  steMismatchError,
} from "../errors.js";
import {
  getIdempotentResponse,
  storeIdempotentResponse,
} from "../eval-set.js";
import { newPolicyId } from "../ids.js";
import { getJobLimits } from "../job.js";
import { projectExists } from "../keys.js";
import {
  DEFAULT_MAX_WAIT_MS,
  getProjectLiveState,
  putPolicy,
  upsertDraftPolicy,
  type UnsignedPolicy,
} from "../policy.js";
import {
  buildCompileApproveUrl,
  signCompileApproveToken,
} from "../routes/compile-approve.js";
import type { ToolHandler } from "../dispatch.js";
import {
  compilePolicyOutputSchema,
  type compilePolicyInputSchema,
} from "./schema.js";
import type { z } from "zod";

type CompileInput = z.infer<typeof compilePolicyInputSchema>;

type RecommendationRow = {
  id: string;
  project_id: string;
  eval_set_id: string;
  named_model_id: string | null;
  backup_model_ids: string;
};

function getRecommendation(
  db: Database.Database,
  recommendationId: string,
): RecommendationRow | null {
  const row = db
    .prepare(
      `SELECT id, project_id, eval_set_id, named_model_id, backup_model_ids
       FROM recommendations
       WHERE id = ?`,
    )
    .get(recommendationId) as RecommendationRow | undefined;
  return row ?? null;
}

function getNamedModelDecision(
  db: Database.Database,
  recommendationId: string,
): "approved" | "rejected" | null {
  const row = db
    .prepare(
      `SELECT decision FROM named_model_approvals WHERE recommendation_id = ?`,
    )
    .get(recommendationId) as { decision: string } | undefined;
  if (row?.decision === "approved" || row?.decision === "rejected") {
    return row.decision;
  }
  return null;
}

function backupIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .slice(0, 2);
  } catch {
    return [];
  }
}

export const handleCompilePolicy: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  const apiKey = ctx.apiKey ?? "";
  const baseUrl = ctx.baseUrl ?? "http://127.0.0.1:3000";
  if (!db) {
    throw new Error("compile_policy requires db on ToolContext");
  }

  const input = body as CompileInput;
  const existing = getIdempotentResponse(
    db,
    "compile_policy",
    input.idempotency_key,
  );
  if (existing) {
    return existing;
  }

  if (!projectExists(db, input.project_id)) {
    return { status: 404, body: projectNotFoundError(input.project_id) };
  }

  const rec = getRecommendation(db, input.recommendation_id);
  if (!rec || rec.project_id !== input.project_id) {
    return {
      status: 400,
      body: recNotApprovedError(input.recommendation_id),
    };
  }

  const decision = getNamedModelDecision(db, rec.id);
  if (decision !== "approved") {
    return { status: 400, body: recNotApprovedError(rec.id) };
  }

  if (rec.named_model_id == null || rec.named_model_id.length === 0) {
    return { status: 400, body: recNotApprovedError(rec.id) };
  }

  if (rec.eval_set_id !== input.eval_set_id) {
    return {
      status: 400,
      body: steMismatchError({
        project_id: input.project_id,
        recommendation_id: rec.id,
        eval_set_id: input.eval_set_id,
      }),
    };
  }

  const limits = getJobLimits(db, rec.eval_set_id);
  const timeoutMs =
    typeof limits?.max_wait_ms === "number" && Number.isFinite(limits.max_wait_ms)
      ? limits.max_wait_ms
      : DEFAULT_MAX_WAIT_MS;

  const backups = backupIds(rec.backup_model_ids);
  const live = getProjectLiveState(db, input.project_id);
  const previousId = live?.last_full_policy_id ?? null;
  const existingCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM policies WHERE project_id = ?`)
      .get(input.project_id) as { n: number }
  ).n;

  const policyId = newPolicyId();
  const unsigned: UnsignedPolicy = {
    policy_id: policyId,
    version: existingCount + 1,
    previous_policy_id: previousId,
    project_id: input.project_id,
    rec_id: rec.id,
    ste_id: rec.eval_set_id,
    compiled_at: new Date().toISOString(),
    primary: { model_id: rec.named_model_id, timeout_ms: timeoutMs },
    backups: backups.map((model_id) => ({ model_id, timeout_ms: timeoutMs })),
    canary: null,
  };

  putPolicy(db, apiKey, unsigned);
  upsertDraftPolicy(db, input.project_id, policyId);

  const token = signCompileApproveToken(apiKey, policyId);
  const approveUrl = buildCompileApproveUrl(baseUrl, policyId, token);

  const output = compilePolicyOutputSchema.parse({
    policy_id: policyId,
    approve_url: approveUrl,
    live_traffic_changed: false,
    next_action: {
      tool: null,
      args: { approve_url: approveUrl },
      ask_human: "open approve_url",
    },
  });

  storeIdempotentResponse(
    db,
    "compile_policy",
    input.idempotency_key,
    200,
    output,
    input.project_id,
  );

  return { status: 200, body: output };
};
