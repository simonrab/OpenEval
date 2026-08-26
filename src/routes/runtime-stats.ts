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
    return { ok: true };
  });
}
