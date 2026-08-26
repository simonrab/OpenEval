import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { agentError, projectNotFoundError } from "../errors.js";
import { projectExists } from "../keys.js";
import { upsertLiveStats } from "../policy.js";
import { ErrorCode } from "../tools/types.js";

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
    feature_id: z.string().min(1).nullable().optional(),
    captured_at: z.string().min(1).optional(),
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
         project_id, policy_id, model_id, feature_id, hashed_request_count,
         canary_request_count, fallback_count, request_count, pii_blocked_count,
         captured_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      body.project_id,
      body.policy_id ?? null,
      body.model_id ?? null,
      body.feature_id ?? null,
      body.hashed_request_count,
      body.canary_request_count,
      body.fallback_count,
      body.request_count,
      body.pii_blocked_count ?? 0,
      body.captured_at ?? new Date().toISOString(),
    );
    return { ok: true };
  });
}
