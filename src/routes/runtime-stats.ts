import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { agentError, projectNotFoundError } from "../errors.js";
import { projectExists } from "../keys.js";
import { upsertLiveStats } from "../policy.js";
import { ErrorCode } from "../tools/types.js";
import { armHasData, recordArmEvent } from "../live/arms.js";

const count = z.number().int().min(0);
const total = z.number().min(0).finite();

/** Change since the SDK's last report, for one policy. */
const armSchema = z
  .object({
    policy_id: z.string().min(1),
    request_count: count,
    fallback_count: count,
    error_count: count,
    pii_blocked_miss_count: count,
    latency_ms_sum: total,
    latency_count: count,
    cost_usd_sum: total,
    cost_count: count,
    quality_checked: count,
    quality_failed: count,
  })
  .strict()
  .refine((a) => a.quality_failed <= a.quality_checked, {
    message: "quality_failed is more than quality_checked",
  });

const statsBodySchema = z
  .object({
    project_id: z.string().min(1),
    hashed_request_count: z.number().int().min(0),
    canary_request_count: z.number().int().min(0),
    fallback_count: z.number().int().min(0),
    request_count: z.number().int().min(0),
    pii_blocked_count: z.number().int().min(0).optional(),
    last_known_loaded_at: z.string().min(1).optional(),
    policy_id: z.string().min(1).nullable().optional(),
    model_id: z.string().min(1).nullable().optional(),
    candidate_id: z.string().min(1).nullable().optional(),
    feature_id: z.string().min(1).nullable().optional(),
    captured_at: z.string().min(1).optional(),
    arms: z.array(armSchema).max(16).optional(),
  })
  .strict();

function invalidStatsBody() {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message: "The stats body is not valid.",
    retryable: true,
    suggested_tool: null,
    suggested_args: {},
    next_action: { tool: null, args: {}, ask_human: null },
  });
}

export async function registerRuntimeStats(
  app: FastifyInstance,
  db: Database.Database,
): Promise<void> {
  app.post("/runtime/stats", async (request, reply) => {
    const parsed = statsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidStatsBody());
    }
    const body = parsed.data;
    if (!projectExists(db, body.project_id)) {
      return reply.code(404).send(projectNotFoundError(body.project_id));
    }
    upsertLiveStats(db, body.project_id, body);
    db.prepare(
      `INSERT INTO runtime_stats_events (
         project_id, policy_id, model_id, candidate_id, feature_id,
         hashed_request_count, canary_request_count, fallback_count,
         request_count, pii_blocked_count, captured_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      body.project_id,
      body.policy_id ?? null,
      body.model_id ?? null,
      body.candidate_id ?? null,
      body.feature_id ?? null,
      body.hashed_request_count,
      body.canary_request_count,
      body.fallback_count,
      body.request_count,
      body.pii_blocked_count ?? 0,
      body.captured_at ?? new Date().toISOString(),
    );
    // Arm rows use server time so the decision cycle window is not skewed by
    // app server clocks.
    const now = new Date().toISOString();
    for (const arm of body.arms ?? []) {
      if (armHasData(arm)) {
        recordArmEvent(db, body.project_id, arm, now);
      }
    }
    return { ok: true };
  });
}
