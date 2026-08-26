import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { noLastKnownPolicyError, projectNotFoundError } from "../errors.js";
import { projectExists } from "../keys.js";
import { formatEtag, getRuntimePolicyDocument, normalizeEtag } from "../policy.js";

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

    const doc = getRuntimePolicyDocument(db, apiKey, project_id);
    if (!doc) {
      return reply.code(404).send(noLastKnownPolicyError(project_id));
    }

    const etagHeader = formatEtag(doc.etag);
    reply.header("etag", etagHeader);

    const incoming = normalizeEtag(request.headers["if-none-match"]);
    if (incoming !== null && incoming === doc.etag) {
      return reply.code(304).send();
    }

    return reply.type("application/json").send(doc.bodyJson);
  });
}
