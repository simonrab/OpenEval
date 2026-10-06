import type Database from "better-sqlite3";
import {
  agentError,
  recNotApprovedError,
  projectNotFoundError,
  steMismatchError,
} from "../errors.js";
import { baseModelId, type Candidate } from "../runner/candidates.js";
import { OPTIMIZE_INTENT } from "../runner/queue.js";
import { ErrorCode } from "./types.js";
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
  POLICY_FORMAT,
  putPolicy,
  upsertDraftPolicy,
  type PolicyModel,
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
  candidate_json: string | null;
  backup_candidates_json: string | null;
  run_intent: string | null;
};

export const POLICY_SYSTEM_PROMPT_NOTE =
  "This policy has the system prompt that won the evals. " +
  "The SDK sends it only when you set applyPolicySystemPrompt to true. " +
  "The proxy sends it only when the request has the header x-openeval-apply-system-prompt: true. " +
  "When it is sent, it replaces the system prompt of your app.";

function getRecommendation(
  db: Database.Database,
  recommendationId: string,
): RecommendationRow | null {
  const row = db
    .prepare(
      `SELECT r.id, r.project_id, r.eval_set_id, r.named_model_id,
              r.backup_model_ids, r.candidate_json, r.backup_candidates_json,
              runs.intent AS run_intent
       FROM recommendations r
       LEFT JOIN runs ON runs.id = r.run_id
       WHERE r.id = ?`,
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

function parseCandidates(raw: string | null): Candidate[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (c): c is Candidate =>
        c !== null && typeof c === "object" && typeof (c as Candidate).id === "string",
    );
  } catch {
    return [];
  }
}

/** A format 2 target entry: the base model id plus the whole setup. */
function targetEntry(
  candidateId: string,
  stored: Candidate | undefined,
  timeoutMs: number,
): PolicyModel {
  const entry: PolicyModel = {
    model_id: stored?.model ?? baseModelId(candidateId),
    timeout_ms: timeoutMs,
    candidate_id: candidateId,
  };
  if (stored?.settings && Object.keys(stored.settings).length > 0) {
    entry.settings = stored.settings;
  }
  if (stored?.system_prompt) {
    entry.system_prompt = stored.system_prompt;
  }
  return entry;
}

function optimizeRunError(projectId: string, evalSetId: string) {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message:
      "This recommendation comes from app harness outputs. Use a recommendation from a run_evals run.",
    retryable: false,
    suggested_tool: "run_evals",
    suggested_args: { project_id: projectId, eval_set_id: evalSetId },
    next_action: {
      tool: "run_evals",
      args: { project_id: projectId, eval_set_id: evalSetId },
      ask_human: null,
    },
  });
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

  if (rec.run_intent === OPTIMIZE_INTENT) {
    return { status: 400, body: optimizeRunError(input.project_id, rec.eval_set_id) };
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

  const winner = parseCandidates(rec.candidate_json).find(
    (c) => c.id === rec.named_model_id,
  );
  const backupSetups = parseCandidates(rec.backup_candidates_json);
  const primary = targetEntry(rec.named_model_id, winner, timeoutMs);

  const policyId = newPolicyId();
  const unsigned: UnsignedPolicy = {
    policy_id: policyId,
    format: POLICY_FORMAT,
    version: existingCount + 1,
    previous_policy_id: previousId,
    project_id: input.project_id,
    rec_id: rec.id,
    ste_id: rec.eval_set_id,
    compiled_at: new Date().toISOString(),
    primary,
    backups: backups.map((id) =>
      targetEntry(id, backupSetups.find((c) => c.id === id), timeoutMs),
    ),
    canary: null,
  };

  putPolicy(db, apiKey, unsigned);
  upsertDraftPolicy(db, input.project_id, policyId);

  const token = signCompileApproveToken(apiKey, policyId);
  const approveUrl = buildCompileApproveUrl(baseUrl, policyId, token);

  const output = compilePolicyOutputSchema.parse({
    policy_id: policyId,
    format: POLICY_FORMAT,
    primary: {
      candidate_id: primary.candidate_id,
      model_id: primary.model_id,
      settings: primary.settings ?? null,
      has_system_prompt: primary.system_prompt !== undefined,
    },
    system_prompt_note: primary.system_prompt ? POLICY_SYSTEM_PROMPT_NOTE : null,
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
