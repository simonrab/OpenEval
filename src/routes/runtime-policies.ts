import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { noLastKnownPolicyError, projectNotFoundError } from "../errors.js";
import { projectExists } from "../keys.js";
import { formatEtag, getLastFullPolicy, normalizeEtag } from "../policy.js";

export async function registerRuntimePolicies(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
): Promise<void> {
  app.get("/runtime/policies/:project_id", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    if (!projectExists(db, project_id)) {
      return reply.code(404).send(projectNotFoundError(project_id));
    }

    const row = getLastFullPolicy(db, apiKey, project_id);
    if (!row) {
      return reply.code(404).send(noLastKnownPolicyError(project_id));
    }

    const etagHeader = formatEtag(row.etag);
    reply.header("etag", etagHeader);

    const incoming = normalizeEtag(request.headers["if-none-match"]);
    if (incoming !== null && incoming === row.etag) {
      return reply.code(304).send();
    }

    return reply.type("application/json").send(row.body_json);
  });
}
