import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  getLastFullPolicy,
  getPolicyRow,
  promoteToLastFullIfNone,
  recordPolicyDecision,
  verifyPolicy,
  type SignedPolicy,
} from "../policy.js";
import { registerFormParser } from "./form-parser.js";

const templatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "compile-approve.html",
);

export function signCompileApproveToken(
  apiKey: string,
  policyId: string,
): string {
  return createHmac("sha256", apiKey)
    .update(`compile-approve:${policyId}`)
    .digest("hex");
}

export function verifyCompileApproveToken(
  apiKey: string,
  policyId: string,
  token: string | undefined,
): boolean {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }
  const expected = signCompileApproveToken(apiKey, policyId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function buildCompileApproveUrl(
  baseUrl: string,
  policyId: string,
  token: string,
): string {
  const url = new URL("/compile-approve", baseUrl);
  url.searchParams.set("policy_id", policyId);
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

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function parseSignedPolicy(bodyJson: string): SignedPolicy | null {
  try {
    return JSON.parse(bodyJson) as SignedPolicy;
  } catch {
    return null;
  }
}

function formatPolicy(doc: SignedPolicy) {
  const backups = doc.backups.map((b) => b.model_id);
  return {
    primary: doc.primary.model_id,
    backups: backups.length > 0 ? backups.join(", ") : "(none)",
    recId: doc.rec_id,
    steId: doc.ste_id,
  };
}

function renderCompileApprovePage(opts: {
  policyId: string;
  token: string;
  primary: string;
  backups: string;
  recId: string;
  steId: string;
  banner: string;
}): string {
  const template = readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{POLICY_ID}}", escapeHtml(opts.policyId))
    .replaceAll("{{TOKEN}}", escapeHtml(opts.token))
    .replaceAll("{{PRIMARY}}", escapeHtml(opts.primary))
    .replaceAll("{{BACKUPS}}", escapeHtml(opts.backups))
    .replaceAll("{{REC_ID}}", escapeHtml(opts.recId))
    .replaceAll("{{STE_ID}}", escapeHtml(opts.steId))
    .replace("{{BANNER}}", opts.banner);
}

function bannerForDecision(
  decision: "approved" | "rejected",
  becameLastFull: boolean,
): string {
  if (decision === "rejected") {
    return "<p>This policy is rejected. The SDK must not send this policy.</p>";
  }
  if (becameLastFull) {
    return "<p>This policy is last full. The SDK will load this policy. This screen did not change live traffic.</p>";
  }
  return "<p>This policy is a draft. Last full policy stays the same.</p>";
}

export async function registerCompileApprove(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
): Promise<void> {
  registerFormParser(app);

  app.get("/compile-approve", async (request, reply) => {
    const query = request.query as {
      policy_id?: string;
      token?: string;
    };
    const policyId = query.policy_id;
    if (!policyId) {
      return reply.code(400).send("policy_id is required");
    }
    if (!verifyCompileApproveToken(apiKey, policyId, query.token)) {
      return reply.code(401).send("unauthorized");
    }
    const row = getPolicyRow(db, policyId);
    if (!row) {
      return reply.code(404).send("policy not found");
    }
    const doc = parseSignedPolicy(row.body_json);
    if (!doc) {
      return reply.code(404).send("policy not found");
    }
    const fmt = formatPolicy(doc);
    const html = renderCompileApprovePage({
      policyId,
      token: query.token ?? "",
      primary: fmt.primary,
      backups: fmt.backups,
      recId: fmt.recId,
      steId: fmt.steId,
      banner: "",
    });
    return reply.type("text/html").send(html);
  });

  app.post("/compile-approve", async (request, reply) => {
    const body =
      request.body !== null &&
      typeof request.body === "object" &&
      !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const policyId = asString(body.policy_id);
    const token = asString(body.token);
    const decision = asString(body.decision);
    if (!policyId) {
      return reply.code(400).send({ error: "policy_id is required" });
    }
    if (!verifyCompileApproveToken(apiKey, policyId, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (decision !== "approved" && decision !== "rejected") {
      return reply.code(400).send({ error: "decision must be approved or rejected" });
    }
    const row = getPolicyRow(db, policyId);
    if (!row) {
      return reply.code(404).send({ error: "policy not found" });
    }
    const doc = parseSignedPolicy(row.body_json);
    if (!doc) {
      return reply.code(404).send({ error: "policy not found" });
    }

    const sealOk = verifyPolicy(apiKey, doc);
    let becameLastFull = false;
    if (decision === "approved" && sealOk) {
      becameLastFull = promoteToLastFullIfNone(
        db,
        apiKey,
        row.project_id,
        policyId,
      );
    }
    if (decision === "approved" && !sealOk) {
      becameLastFull = false;
    }
    recordPolicyDecision(db, policyId, decision);

    const lastFull = getLastFullPolicy(db, apiKey, row.project_id);
    if (lastFull?.id === policyId) {
      becameLastFull = true;
    }

    const result = {
      policy_id: policyId,
      decision,
      live_traffic_changed: false,
      last_full: lastFull?.id === policyId,
      next_action: {
        tool: null,
        args: {},
        ask_human: decision === "rejected" ? "open approve_url" : null,
      },
    };

    const wantsJson =
      String(request.headers["content-type"] ?? "").includes("application/json") ||
      String(request.headers.accept ?? "").includes("application/json");
    if (wantsJson) {
      return reply.code(200).send(result);
    }

    const fmt = formatPolicy(doc);
    const html = renderCompileApprovePage({
      policyId,
      token: token ?? "",
      primary: fmt.primary,
      backups: fmt.backups,
      recId: fmt.recId,
      steId: fmt.steId,
      banner: bannerForDecision(decision, becameLastFull),
    });
    return reply.type("text/html").send(html);
  });
}
