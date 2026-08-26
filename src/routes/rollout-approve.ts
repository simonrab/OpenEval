import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildReportUrl } from "../report-token.js";
import {
  activateCanary,
  clearCanary,
  getPolicyRow,
  getProjectLiveState,
  promotePolicyCanaryToLastFull,
  rollbackToLastFull,
  rollbackToPolicy,
  verifyPolicy,
  type SignedPolicy,
} from "../policy.js";
import { getLiveRollout, markRolloutDecision } from "../rollouts.js";
import { registerFormParser } from "./form-parser.js";

const templatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "rollout-approve.html",
);

export function signRolloutApproveToken(
  apiKey: string,
  rolloutId: string,
): string {
  return createHmac("sha256", apiKey)
    .update(`rollout-approve:${rolloutId}`)
    .digest("hex");
}

export function verifyRolloutApproveToken(
  apiKey: string,
  rolloutId: string,
  token: string | undefined,
): boolean {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }
  const expected = signRolloutApproveToken(apiKey, rolloutId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function buildRolloutApproveUrl(
  baseUrl: string,
  rolloutId: string,
  token: string,
): string {
  const url = new URL("/rollout-approve", baseUrl);
  url.searchParams.set("rollout_id", rolloutId);
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

function policyLabel(
  db: Database.Database,
  policyId: string | null,
): string {
  if (!policyId) {
    return "(none)";
  }
  const row = getPolicyRow(db, policyId);
  if (!row) {
    return policyId;
  }
  const doc = parseSignedPolicy(row.body_json);
  if (!doc) {
    return policyId;
  }
  return `${policyId} (${doc.primary.model_id})`;
}

function intentLabel(intent: string): string {
  if (intent === "canary") {
    return "canary 5 percent";
  }
  if (intent === "full") {
    return "full";
  }
  return "rollback";
}

function formatPercent(value: number): string {
  if (Number.isInteger(value)) {
    return `${value} percent`;
  }
  return `${value.toFixed(1)} percent`;
}

function reportLink(
  db: Database.Database,
  apiKey: string,
  baseUrl: string,
  policyId: string | null,
): string {
  if (!policyId) {
    return "(none)";
  }
  const row = getPolicyRow(db, policyId);
  if (!row) {
    return "(none)";
  }
  const doc = parseSignedPolicy(row.body_json);
  if (!doc) {
    return "(none)";
  }
  const rec = db
    .prepare(`SELECT run_id, project_id FROM recommendations WHERE id = ?`)
    .get(doc.rec_id) as { run_id: string; project_id: string } | undefined;
  if (!rec) {
    return "(none)";
  }
  const href = buildReportUrl(baseUrl, apiKey, {
    project_id: rec.project_id,
    run_id: rec.run_id,
  });
  return `<a href="${escapeHtml(href)}">v0 report</a>`;
}

function renderRolloutPage(opts: {
  rolloutId: string;
  token: string;
  oldPol: string;
  newPol: string;
  intent: string;
  intendedSplit: string;
  observedSplit: string;
  fallbackRate: string;
  rollbackTarget: string;
  reportLink: string;
  banner: string;
}): string {
  const template = readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{ROLLOUT_ID}}", escapeHtml(opts.rolloutId))
    .replaceAll("{{TOKEN}}", escapeHtml(opts.token))
    .replaceAll("{{OLD_POL}}", escapeHtml(opts.oldPol))
    .replaceAll("{{NEW_POL}}", escapeHtml(opts.newPol))
    .replaceAll("{{INTENT}}", escapeHtml(opts.intent))
    .replaceAll("{{INTENDED_SPLIT}}", escapeHtml(opts.intendedSplit))
    .replaceAll("{{OBSERVED_SPLIT}}", escapeHtml(opts.observedSplit))
    .replaceAll("{{FALLBACK_RATE}}", escapeHtml(opts.fallbackRate))
    .replaceAll("{{ROLLBACK_TARGET}}", escapeHtml(opts.rollbackTarget))
    .replace("{{REPORT_LINK}}", opts.reportLink)
    .replace("{{BANNER}}", opts.banner);
}

function pageModel(
  db: Database.Database,
  apiKey: string,
  baseUrl: string,
  rolloutId: string,
  token: string,
  banner: string,
): string | null {
  const rollout = getLiveRollout(db, rolloutId);
  if (!rollout) {
    return null;
  }
  const live = getProjectLiveState(db, rollout.project_id);
  const hashed = live?.hashed_request_count ?? 0;
  const canaryCount = live?.canary_request_count ?? 0;
  const requests = live?.request_count ?? 0;
  const fallbacks = live?.fallback_count ?? 0;
  const observed =
    hashed === 0 ? 0 : (canaryCount / hashed) * 100;
  const fallbackRate = requests === 0 ? 0 : fallbacks / requests;
  const intended =
    rollout.intent === "canary" || (live?.canary_percent === 5 && rollout.intent !== "rollback")
      ? 5
      : 0;
  return renderRolloutPage({
    rolloutId,
    token,
    oldPol: policyLabel(db, rollout.old_policy_id),
    newPol: policyLabel(db, rollout.new_policy_id),
    intent: intentLabel(rollout.intent),
    intendedSplit: formatPercent(intended),
    observedSplit: formatPercent(observed),
    fallbackRate: formatPercent(fallbackRate * 100),
    rollbackTarget: policyLabel(db, rollout.rollback_target_policy_id),
    reportLink: reportLink(
      db,
      apiKey,
      baseUrl,
      rollout.new_policy_id ?? rollout.old_policy_id,
    ),
    banner,
  });
}

function bannerForDecision(
  decision: "approved" | "rejected" | "rollback",
  intent: string,
): string {
  if (decision === "rejected") {
    return "<p>This rollout is rejected. Live traffic stays as it is.</p>";
  }
  if (decision === "rollback" || intent === "rollback") {
    return "<p>Last full policy is at 100 percent. Canary is off. This action did not run evals.</p>";
  }
  if (intent === "canary") {
    return "<p>Canary is on at 5 percent. The SDK loads this split on the next timer.</p>";
  }
  return "<p>The canary policy is now last full at 100 percent. Canary is off.</p>";
}

function applyDecision(
  db: Database.Database,
  apiKey: string,
  rolloutId: string,
  decision: "approved" | "rejected" | "rollback",
): boolean {
  const rollout = getLiveRollout(db, rolloutId);
  if (!rollout) {
    return false;
  }
  if (rollout.status !== "pending") {
    return true;
  }
  if (decision === "rejected") {
    markRolloutDecision(db, rolloutId, "rejected");
    return true;
  }
  if (decision === "rollback" || rollout.intent === "rollback") {
    const target =
      rollout.rollback_target_policy_id ?? rollout.new_policy_id ?? rollout.old_policy_id;
    const changed = target
      ? rollbackToPolicy(db, rollout.project_id, target)
      : rollbackToLastFull(db, rollout.project_id);
    markRolloutDecision(db, rolloutId, changed ? "approved" : "rejected");
    return changed;
  }
  if (rollout.intent === "canary") {
    if (!rollout.new_policy_id) {
      markRolloutDecision(db, rolloutId, "rejected");
      return false;
    }
    const row = getPolicyRow(db, rollout.new_policy_id);
    const doc = row ? parseSignedPolicy(row.body_json) : null;
    if (!row || !doc || !verifyPolicy(apiKey, doc)) {
      markRolloutDecision(db, rolloutId, "rejected");
      return false;
    }
    activateCanary(db, apiKey, rollout.project_id, rollout.new_policy_id);
    markRolloutDecision(db, rolloutId, "approved");
    return true;
  }
  if (!rollout.new_policy_id) {
    markRolloutDecision(db, rolloutId, "rejected");
    return false;
  }
  const row = getPolicyRow(db, rollout.new_policy_id);
  const doc = row ? parseSignedPolicy(row.body_json) : null;
  if (!row || !doc || !verifyPolicy(apiKey, doc)) {
    markRolloutDecision(db, rolloutId, "rejected");
    return false;
  }
  const changed = promotePolicyCanaryToLastFull(
    db,
    rollout.project_id,
    rollout.new_policy_id,
  );
  if (changed) {
    clearCanary(db, rollout.project_id);
  }
  markRolloutDecision(db, rolloutId, changed ? "approved" : "rejected");
  return changed;
}

export async function registerRolloutApprove(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
  baseUrl: string,
): Promise<void> {
  registerFormParser(app);

  app.get("/rollout-approve", async (request, reply) => {
    const query = request.query as {
      rollout_id?: string;
      token?: string;
    };
    const rolloutId = query.rollout_id;
    if (!rolloutId) {
      return reply.code(400).send("rollout_id is required");
    }
    if (!verifyRolloutApproveToken(apiKey, rolloutId, query.token)) {
      return reply.code(401).send("unauthorized");
    }
    const html = pageModel(db, apiKey, baseUrl, rolloutId, query.token ?? "", "");
    if (!html) {
      return reply.code(404).send("rollout not found");
    }
    return reply.type("text/html").send(html);
  });

  app.post("/rollout-approve", async (request, reply) => {
    const body =
      request.body !== null &&
      typeof request.body === "object" &&
      !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const rolloutId = asString(body.rollout_id);
    const token = asString(body.token);
    const decision = asString(body.decision);
    if (!rolloutId) {
      return reply.code(400).send({ error: "rollout_id is required" });
    }
    if (!verifyRolloutApproveToken(apiKey, rolloutId, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (
      decision !== "approved" &&
      decision !== "rejected" &&
      decision !== "rollback"
    ) {
      return reply.code(400).send({ error: "decision must be approved or rejected" });
    }
    const rollout = getLiveRollout(db, rolloutId);
    if (!rollout) {
      return reply.code(404).send({ error: "rollout not found" });
    }

    const applied = applyDecision(db, apiKey, rolloutId, decision);
    const effectiveDecision = applied ? decision : "rejected";

    const result = {
      rollout_id: rolloutId,
      decision: effectiveDecision,
      live_traffic_changed: false,
      next_action: {
        tool: null,
        args: {},
        ask_human: effectiveDecision === "rejected" ? "open approve_url" : null,
      },
    };

    const wantsJson =
      String(request.headers["content-type"] ?? "").includes("application/json") ||
      String(request.headers.accept ?? "").includes("application/json");
    if (wantsJson) {
      return reply.code(200).send(result);
    }

    const html = pageModel(
      db,
      apiKey,
      baseUrl,
      rolloutId,
      token ?? "",
      bannerForDecision(effectiveDecision, rollout.intent),
    );
    if (!html) {
      return reply.code(404).send({ error: "rollout not found" });
    }
    return reply.type("text/html").send(html);
  });
}
