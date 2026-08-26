import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { newProjectId } from "../ids.js";
import { listProjectKeysRefs, projectExists } from "../keys.js";
import { projectNotFoundError } from "../errors.js";

export async function registerProjects(
  app: FastifyInstance,
  db: Database.Database,
): Promise<void> {
  app.post("/projects", async () => {
    const projectId = newProjectId();
    const createdAt = new Date().toISOString();
    db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
      projectId,
      createdAt,
    );
    return { project_id: projectId };
  });

  app.get("/projects/:project_id", async (request, reply) => {
    const { project_id } = request.params as { project_id: string };
    if (!projectExists(db, project_id)) {
      return reply.code(404).send(projectNotFoundError(project_id));
    }
    return {
      project_id,
      keys_refs: listProjectKeysRefs(db, project_id),
    };
  });
}
