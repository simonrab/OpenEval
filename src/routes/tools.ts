import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { dispatch } from "../dispatch.js";

const TOOLS_BODY_LIMIT = 16 * 1024 * 1024;

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
  // submit_outputs carries many outputs in one body.
  app.post("/tools/:name", { bodyLimit: TOOLS_BODY_LIMIT }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const result = await dispatch(name, request.body, {
      db,
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      openRouter: ctx.openRouter,
      scope: request.authScope,
    });
    return reply.code(result.status).send(result.body);
  });
}
