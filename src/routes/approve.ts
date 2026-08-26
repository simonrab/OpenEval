import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { registerFormParser } from "./form-parser.js";

const templatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "approve.html",
);

export function signApproveToken(
  apiKey: string,
  recommendationId: string,
): string {
  return createHmac("sha256", apiKey)
    .update(`approve:${recommendationId}`)
    .digest("hex");
}

export function verifyApproveToken(
  apiKey: string,
  recommendationId: string,
  token: string | undefined,
): boolean {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }
  const expected = signApproveToken(apiKey, recommendationId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function buildApproveUrl(
  baseUrl: string,
  recommendationId: string,
  token: string,
): string {
  const url = new URL("/approve", baseUrl);
  url.searchParams.set("recommendation_id", recommendationId);
  url.searchParams.set("token", token);
  return url.toString();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type RecommendationRow = {
  id: string;
  named_model_id: string | null;
  backup_model_ids: string;
  quality_json: string;
  time_json: string;
  cost_usd: number;
  failing_eval_ids: string;
};

function getRecommendation(
  db: Database.Database,
  recommendationId: string,
): RecommendationRow | null {
  const row = db
    .prepare(
      `SELECT id, named_model_id, backup_model_ids, quality_json, time_json, cost_usd, failing_eval_ids
       FROM recommendations WHERE id = ?`,
    )
    .get(recommendationId) as RecommendationRow | undefined;
  return row ?? null;
}

function renderApprovePage(opts: {
  recommendationId: string;
  token: string;
  namedModel: string;
  backups: string;
  quality: string;
  timeP50: string;
  timeP95: string;
  costUsd: string;
  failingEvals: string;
  banner: string;
}): string {
  const template = readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{RECOMMENDATION_ID}}", escapeHtml(opts.recommendationId))
    .replaceAll("{{TOKEN}}", escapeHtml(opts.token))
    .replaceAll("{{NAMED_MODEL}}", escapeHtml(opts.namedModel))
    .replaceAll("{{BACKUPS}}", escapeHtml(opts.backups))
    .replaceAll("{{QUALITY}}", escapeHtml(opts.quality))
    .replaceAll("{{TIME_P50}}", escapeHtml(opts.timeP50))
    .replaceAll("{{TIME_P95}}", escapeHtml(opts.timeP95))
    .replaceAll("{{COST_USD}}", escapeHtml(opts.costUsd))
    .replaceAll("{{FAILING_EVALS}}", escapeHtml(opts.failingEvals))
    .replace("{{BANNER}}", opts.banner);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function formatRecommendation(rec: RecommendationRow) {
  const quality = JSON.parse(rec.quality_json) as {
    n_pass: number;
    n_fail: number;
  };
  const time = JSON.parse(rec.time_json) as { p50: number; p95: number };
  const backups = JSON.parse(rec.backup_model_ids) as string[];
  const failing = JSON.parse(rec.failing_eval_ids) as string[];
  return {
    namedModel: rec.named_model_id ?? "(none)",
    backups: backups.length > 0 ? backups.join(", ") : "(none)",
    quality: `${quality.n_pass} pass, ${quality.n_fail} fail`,
    timeP50: String(Math.round(time.p50)),
    timeP95: String(Math.round(time.p95)),
    costUsd: rec.cost_usd.toFixed(4),
    failingEvals: failing.length > 0 ? failing.join(", ") : "(none)",
  };
}

export async function registerApprove(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
): Promise<void> {
  registerFormParser(app);

  app.get("/approve", async (request, reply) => {
    const query = request.query as {
      recommendation_id?: string;
      token?: string;
    };
    const recommendationId = query.recommendation_id;
    if (!recommendationId) {
      return reply.code(400).send("recommendation_id is required");
    }
    if (!verifyApproveToken(apiKey, recommendationId, query.token)) {
      return reply.code(401).send("unauthorized");
    }
    const rec = getRecommendation(db, recommendationId);
    if (!rec) {
      return reply.code(404).send("recommendation not found");
    }
    const fmt = formatRecommendation(rec);
    const html = renderApprovePage({
      recommendationId,
      token: query.token ?? "",
      namedModel: fmt.namedModel,
      backups: fmt.backups,
      quality: fmt.quality,
      timeP50: fmt.timeP50,
      timeP95: fmt.timeP95,
      costUsd: fmt.costUsd,
      failingEvals: fmt.failingEvals,
      banner: "",
    });
    return reply.type("text/html").send(html);
  });

  app.post("/approve", async (request, reply) => {
    const body =
      request.body !== null &&
      typeof request.body === "object" &&
      !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const recommendationId = asString(body.recommendation_id);
    const token = asString(body.token);
    const decision = asString(body.decision);
    if (!recommendationId) {
      return reply.code(400).send({ error: "recommendation_id is required" });
    }
    if (!verifyApproveToken(apiKey, recommendationId, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (decision !== "approved" && decision !== "rejected") {
      return reply.code(400).send({ error: "decision must be approved or rejected" });
    }
    const rec = getRecommendation(db, recommendationId);
    if (!rec) {
      return reply.code(404).send({ error: "recommendation not found" });
    }

    db.prepare(
      `INSERT INTO named_model_approvals (recommendation_id, decision, decided_at)
       VALUES (?, ?, ?)
       ON CONFLICT(recommendation_id) DO UPDATE SET
         decision = excluded.decision,
         decided_at = excluded.decided_at`,
    ).run(recommendationId, decision, new Date().toISOString());

    const result = {
      recommendation_id: recommendationId,
      decision,
      live_traffic_changed: false,
      next_action: {
        tool: null,
        args: {},
        ask_human:
          decision === "approved"
            ? null
            : "named model rejected; do not write it into config",
      },
    };

    const wantsJson =
      String(request.headers["content-type"] ?? "").includes("application/json") ||
      String(request.headers.accept ?? "").includes("application/json");
    if (wantsJson) {
      return reply.code(200).send(result);
    }

    const fmt = formatRecommendation(rec);
    const html = renderApprovePage({
      recommendationId,
      token: token ?? "",
      namedModel: fmt.namedModel,
      backups: fmt.backups,
      quality: fmt.quality,
      timeP50: fmt.timeP50,
      timeP95: fmt.timeP95,
      costUsd: fmt.costUsd,
      failingEvals: fmt.failingEvals,
      banner: `<p>Saved decision: ${escapeHtml(decision)}. EvalRouter did not write app config. live_traffic_changed = false.</p>`,
    });
    return reply.type("text/html").send(html);
  });
}

export function approveToken(apiKey: string, recommendationId: string): string {
  return signApproveToken(apiKey, recommendationId);
}
