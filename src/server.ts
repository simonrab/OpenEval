import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { createAuthHook, storeApiKeyHash } from "./auth.js";
import { defaultSqlitePath, openDb } from "./db.js";
import { registerAccept } from "./routes/accept.js";
import { registerApprove } from "./routes/approve.js";
import { registerMarkRoutes } from "./mark/app.js";
import { registerHealth } from "./routes/health.js";
import { registerKeys } from "./routes/keys.js";
import { registerProjects } from "./routes/projects.js";
import { registerReport } from "./routes/report.js";
import { registerTools } from "./routes/tools.js";
import {
  createOpenRouterClient,
  type OpenRouterClient,
} from "./runner/openrouter.js";
import { startWorker } from "./runner/worker.js";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

export type AppOptions = {
  sqlitePath: string;
  apiKey: string;
  logger?: boolean;
  openRouterClient?: OpenRouterClient;
  baseUrl?: string;
};

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const db = openDb(opts.sqlitePath);
  storeApiKeyHash(db, opts.apiKey);

  const openRouter = opts.openRouterClient ?? createOpenRouterClient();
  const stopWorker = startWorker({
    db,
    apiKey: opts.apiKey,
    openRouter,
  });

  const baseUrl = opts.baseUrl ?? "http://127.0.0.1:3000";

  const app = Fastify({ logger: opts.logger ?? false });
  app.addHook("onClose", async () => {
    stopWorker();
    db.close();
  });

  await registerHealth(app);
  await registerAccept(app, db, opts.apiKey);
  await registerApprove(app, db, opts.apiKey);
  await registerMarkRoutes(app, db, opts.apiKey);
  await registerReport(app);

  await app.register(async (v1) => {
    v1.addHook("preHandler", createAuthHook(db));
    await registerProjects(v1, db);
    await registerKeys(v1, db, opts.apiKey);
    await registerTools(v1, db, { baseUrl, apiKey: opts.apiKey, openRouter });
  }, { prefix: "/v1" });

  return app;
}

async function main(): Promise<void> {
  const apiKey = process.env.EVALROUTER_KEY;
  if (!apiKey) {
    console.error("EVALROUTER_KEY is required");
    process.exit(1);
  }

  const sqlitePath = defaultSqlitePath();
  const app = await buildApp({
    sqlitePath,
    apiKey,
    logger: true,
  });

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  await app.listen({ port, host });
  app.log.info(`EvalRouter listening on ${host}:${port}`);
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
