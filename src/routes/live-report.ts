import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { verifyLiveReportToken } from "../live-report-token.js";
import { buildLiveReport } from "../tools/get_live_report.js";

const templatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "live-report.html",
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "0 percent";
  }
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} percent`;
}

type LiveReportBody = {
  policy_id: string | null;
  canary: boolean;
  intended_split: number;
  observed_split: number;
  fallback_rate: number;
  sample_counts: { stored: number; dropped: number; pii_blocked: number };
  last_known_age_s: number | null;
};

function renderLiveReportPage(template: string, body: LiveReportBody): string {
  const age =
    body.last_known_age_s == null ? "none" : `${body.last_known_age_s} s`;
  return template
    .replaceAll("{{POLICY_ID}}", escapeHtml(body.policy_id ?? "none"))
    .replaceAll("{{CANARY}}", body.canary ? "on" : "off")
    .replaceAll("{{INTENDED_SPLIT}}", escapeHtml(formatPercent(body.intended_split)))
    .replaceAll("{{OBSERVED_SPLIT}}", escapeHtml(formatPercent(body.observed_split)))
    .replaceAll(
      "{{FALLBACK_RATE}}",
      escapeHtml(formatPercent(body.fallback_rate * 100)),
    )
    .replaceAll("{{STORED}}", String(body.sample_counts.stored))
    .replaceAll("{{DROPPED}}", String(body.sample_counts.dropped))
    .replaceAll("{{PII_BLOCKED}}", String(body.sample_counts.pii_blocked))
    .replaceAll("{{LAST_KNOWN_AGE}}", escapeHtml(age));
}

export async function registerLiveReport(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
  baseUrl: string,
): Promise<void> {
  const html = readFileSync(templatePath, "utf8");
  app.get("/live-report", async (request, reply) => {
    const query = request.query as { token?: unknown };
    const token = asString(query.token);
    const payload = verifyLiveReportToken(apiKey, token);
    if (!payload) {
      return reply.code(401).send("unauthorized");
    }

    const report = buildLiveReport(
      db,
      { project_id: payload.project_id },
      baseUrl,
      apiKey,
    );
    if (report.status !== 200) {
      return reply.code(report.status).send(report.body);
    }

    return reply
      .type("text/html")
      .send(renderLiveReportPage(html, report.body as LiveReportBody));
  });
}
