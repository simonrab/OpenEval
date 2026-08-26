import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { agentError, piiBlockedError, projectNotFoundError } from "../errors.js";
import { newSampleId } from "../ids.js";
import { projectExists } from "../keys.js";
import { ErrorCode } from "../tools/types.js";
import { redactSampleFields, SAMPLE_WHY } from "../live/redact.js";

const sampleBodySchema = z
  .object({
    sample_id: z.string().regex(/^smp_[0-9a-f]+$/).optional(),
    project_id: z.string().min(1),
    policy_id: z.string().min(1),
    model_id: z.string().min(1),
    why: z.enum(SAMPLE_WHY),
    input_redacted: z.string(),
    output_redacted: z.string(),
    captured_at: z.string().min(1),
  })
  .strict();

function invalidSampleBody() {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message: "The sample body is not valid.",
    retryable: true,
    suggested_tool: null,
    suggested_args: {},
    next_action: { tool: null, args: {}, ask_human: null },
  });
}

export async function registerRuntimeSamples(
  app: FastifyInstance,
  db: Database.Database,
): Promise<void> {
  app.post("/runtime/samples", async (request, reply) => {
    const parsed = sampleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidSampleBody());
    }

    const body = parsed.data;
    if (!projectExists(db, body.project_id)) {
      return reply.code(404).send(projectNotFoundError(body.project_id));
    }

    const redacted = redactSampleFields(body.input_redacted, body.output_redacted);
    if (!redacted.ok) {
      return reply.code(400).send(piiBlockedError());
    }

    const sampleId = body.sample_id ?? newSampleId();
    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO samples (
         id, project_id, policy_id, model_id, why,
         input_redacted, output_redacted, captured_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sampleId,
      body.project_id,
      body.policy_id,
      body.model_id,
      body.why,
      redacted.input_redacted,
      redacted.output_redacted,
      body.captured_at,
      createdAt,
    );

    return { sample_id: sampleId };
  });
}
