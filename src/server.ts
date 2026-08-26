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
import { registerCompileApprove } from "./routes/compile-approve.js";
import { registerRolloutApprove } from "./routes/rollout-approve.js";
import { registerSampleScreen } from "./routes/sample.js";
import { registerMarkRoutes } from "./mark/app.js";
import { registerHealth } from "./routes/health.js";
import { registerKeys } from "./routes/keys.js";
import { registerProjects } from "./routes/projects.js";
import { registerReport } from "./routes/report.js";
import { registerLiveReport } from "./routes/live-report.js";
import { registerRuntimePolicies } from "./routes/runtime-policies.js";
import { registerRuntimeSamples } from "./routes/runtime-samples.js";
import { registerRuntimeStats } from "./routes/runtime-stats.js";
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

export function deriveBaseUrl(env: {
  EVALROUTER_BASE_URL?: string;
  HOST?: string;
  PORT?: string;
}): string {
  const explicit = env.EVALROUTER_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = env.PORT?.trim() || "3000";
  return `http://${host}:${port}`;
}

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
  await registerCompileApprove(app, db, opts.apiKey);
  await registerRolloutApprove(app, db, opts.apiKey, baseUrl);
  await registerSampleScreen(app, db, opts.apiKey, baseUrl);
  await registerMarkRoutes(app, db, opts.apiKey);
  await registerReport(app, db, opts.apiKey, baseUrl);
  await registerLiveReport(app, db, opts.apiKey, baseUrl);

  await app.register(async (v1) => {
    v1.addHook("preHandler", createAuthHook(db));
    await registerProjects(v1, db);
    await registerKeys(v1, db, opts.apiKey);
    await registerRuntimePolicies(v1, db, opts.apiKey);
    await registerRuntimeSamples(v1, db);
    await registerRuntimeStats(v1, db);
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
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const app = await buildApp({
    sqlitePath,
    apiKey,
    logger: true,
    baseUrl: deriveBaseUrl(process.env),
  });

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
