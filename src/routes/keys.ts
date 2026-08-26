import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { agentError, projectNotFoundError } from "../errors.js";
import {
  deriveWrapKey,
  getKeyMeta,
  projectExists,
  storeKey,
} from "../keys.js";
import { ErrorCode } from "../tools/types.js";

const createKeyBodySchema = z
  .object({
    project_id: z.string().min(1),
    secret: z.string().min(1),
    provider: z.string().min(1).nullable().optional(),
  })
  .strict();

function invalidKeyInput(message: string) {
  return agentError({
    code: ErrorCode.INVALID_INPUT,
    message,
    retryable: true,
    suggested_tool: null,
    suggested_args: {},
    next_action: { tool: null, args: {}, ask_human: null },
  });
}

export async function registerKeys(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
): Promise<void> {
  const wrapKey = deriveWrapKey(apiKey);

  app.post("/keys", async (request, reply) => {
    const parsed = createKeyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidKeyInput("invalid keys body"));
    }

    const { project_id, secret, provider } = parsed.data;
    if (!projectExists(db, project_id)) {
      return reply.code(404).send(projectNotFoundError(project_id));
    }

    const keysRef = storeKey(db, wrapKey, {
      projectId: project_id,
      secret,
      provider,
    });
    return { keys_ref: keysRef };
  });

  app.get("/keys/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const meta = getKeyMeta(db, id);
    if (!meta) {
      return reply.code(404).send({ error: "not_found" });
    }
    return meta;
  });
}
