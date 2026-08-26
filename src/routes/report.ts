import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { verifyReportToken } from "../report-token.js";
import { buildReport } from "../tools/get_eval_report.js";

const templatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "report.html",
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

type ReportBody = {
  status: string;
  code: string | null;
  summary: {
    run_id: string;
    n_pass: number;
    n_fail: number;
    cost_usd: number;
    time_ms: { p50: number; p95: number };
  };
  models: Array<{
    model_id: string;
    n_pass: number;
    n_fail: number;
    failing_eval_ids: string[];
  }>;
  items: Array<{
    eval_id: string;
    title: string;
    passed: boolean;
    reason_short: string;
  }>;
};

function renderReportPage(template: string, body: ReportBody): string {
  const modelRows =
    body.models.length === 0
      ? `<tr><td colspan="4">No model rows yet.</td></tr>`
      : body.models
          .map(
            (model) => `<tr>
  <td>${escapeHtml(model.model_id)}</td>
  <td>${model.n_pass}</td>
  <td>${model.n_fail}</td>
  <td>${escapeHtml(model.failing_eval_ids.join(", "))}</td>
</tr>`,
          )
          .join("\n");
  const evalRows =
    body.items.length === 0
      ? `<tr><td colspan="3">No eval rows yet.</td></tr>`
      : body.items
          .map(
            (item) => `<tr>
  <td>${escapeHtml(item.title)}</td>
  <td class="${item.passed ? "pass" : "fail"}">${item.passed ? "pass" : "fail"}</td>
  <td>${escapeHtml(item.reason_short)}</td>
</tr>`,
          )
          .join("\n");
  const code = body.code ? `, code ${body.code}` : "";
  const summary = `Run ${body.summary.run_id} - status ${body.status}${code}. Pass ${body.summary.n_pass}, fail ${body.summary.n_fail}. Cost $${body.summary.cost_usd.toFixed(4)}. p50 ${Math.round(body.summary.time_ms.p50)}ms, p95 ${Math.round(body.summary.time_ms.p95)}ms.`;

  return template
    .replaceAll("{{SUMMARY}}", escapeHtml(summary))
    .replace("{{MODEL_ROWS}}", modelRows)
    .replace("{{EVAL_ROWS}}", evalRows);
}

export async function registerReport(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
  baseUrl: string,
): Promise<void> {
  const html = readFileSync(templatePath, "utf8");
  app.get("/report", async (request, reply) => {
    const query = request.query as { token?: unknown };
    const token = asString(query.token);
    const payload = verifyReportToken(apiKey, token);
    if (!payload) {
      return reply.code(401).send("unauthorized");
    }

    const report = buildReport(
      db,
      { project_id: payload.project_id, run_id: payload.run_id },
      baseUrl,
      apiKey,
    );
    if (report.status !== 200) {
      return reply.code(report.status).send(report.body);
    }

    return reply
      .type("text/html")
      .send(renderReportPage(html, report.body as ReportBody));
  });
}
