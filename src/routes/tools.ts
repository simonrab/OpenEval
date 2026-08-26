import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { dispatch } from "../dispatch.js";

export type ToolsRouteContext = {
  baseUrl?: string;
  apiKey?: string;
  openRouter?: import("../runner/openrouter.js").OpenRouterClient;
};

export async function registerTools(
  app: FastifyInstance,
  db: Database.Database,
  ctx: ToolsRouteContext = {},
): Promise<void> {
  app.post("/tools/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const result = await dispatch(name, request.body, {
      db,
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      openRouter: ctx.openRouter,
    });
    return reply.code(result.status).send(result.body);
  });
}
