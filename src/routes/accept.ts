import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  applyAcceptDecisions,
  getEvalSet,
  getJobDescription,
  listMembers,
  nextActionForSet,
  type MemberEval,
} from "../eval-set.js";
import { registerFormParser } from "./form-parser.js";

const templatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "accept.html",
);

export function signAcceptToken(apiKey: string, evalSetId: string): string {
  return createHmac("sha256", apiKey).update(`accept:${evalSetId}`).digest("hex");
}

export function verifyAcceptToken(
  apiKey: string,
  evalSetId: string,
  token: string | undefined,
): boolean {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }
  const expected = signAcceptToken(apiKey, evalSetId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function buildAcceptUrl(
  baseUrl: string,
  evalSetId: string,
  token: string,
): string {
  const url = new URL("/accept", baseUrl);
  url.searchParams.set("eval_set_id", evalSetId);
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

function renderAcceptPage(opts: {
  evalSetId: string;
  version: number;
  token: string;
  members: MemberEval[];
  banner: string;
  jobDescription: string;
}): string {
  const template = readFileSync(templatePath, "utf8");
  const job =
    opts.jobDescription.trim().length > 0
      ? opts.jobDescription
      : "No job text is stored for this eval set.";
  const labeled = labeledMembers(opts.members);
  const labels = uniqueLabels(opts.members);
  const key =
    labeled && labels.length > 0
      ? `<p class="key">${labels
          .map(
            (label, i) =>
              `<span class="badge ${badgeClass(i)}">${escapeHtml(label)}</span>`,
          )
          .join(" ")}</p>`
      : "";
  const hint = labeled
    ? "Agree if the label is right."
    : "Keep an example if it is a real check for this job.";
  const foot = `Draft examples. Eval set ${opts.evalSetId} · version ${opts.version}. No model runs here.`;
  return template
    .replaceAll("{{HEADING}}", "Review examples")
    .replaceAll("{{EVAL_SET_ID}}", escapeHtml(opts.evalSetId))
    .replaceAll("{{VERSION}}", String(opts.version))
    .replaceAll("{{TOKEN}}", escapeHtml(opts.token))
    .replaceAll("{{JOB_DESCRIPTION}}", escapeHtml(job))
    .replace("{{KEY}}", key)
    .replace("{{HINT}}", escapeHtml(hint))
    .replace("{{BUTTON}}", "Save")
    .replace("{{FOOT}}", escapeHtml(foot))
    .replace("{{EVAL_ROWS}}", evalRowsHtml(opts.members))
    .replace("{{BANNER}}", opts.banner);
}

function labeledMembers(members: MemberEval[]): boolean {
  return members.some((m) => m.form_spec != null);
}

function uniqueLabels(members: MemberEval[]): string[] {
  const seen: string[] = [];
  for (const m of members) {
    const label = m.form_spec?.label;
    if (label && !seen.includes(label)) {
      seen.push(label);
    }
  }
  return seen;
}

function badgeClass(index: number): string {
  return index % 2 === 0 ? "badge-a" : "badge-b";
}

function evalRowsHtml(members: MemberEval[]): string {
  if (members.length === 0) {
    return "<li>No drafts left on this eval set.</li>";
  }
  if (labeledMembers(members)) {
    return labeledRowsHtml(members);
  }
  return genericRowsHtml(members);
}

function labeledRowsHtml(members: MemberEval[]): string {
  const labels = uniqueLabels(members);
  return members
    .filter((m) => m.form_spec != null)
    .map((m) => {
      const id = escapeHtml(m.eval_id);
      const spec = m.form_spec!;
      const badgeCls = badgeClass(Math.max(0, labels.indexOf(spec.label)));
      const quote = escapeHtml(spec.text);
      return `<li class="card">
  <span class="badge ${badgeCls}">${escapeHtml(spec.label)}</span>
  <p class="quote">${quote}</p>
  <div class="choices">
    <label><input type="radio" name="decision_${id}" value="accept" checked> Agree</label>
    <label><input type="radio" name="decision_${id}" value="reject"> Wrong</label>
  </div>
</li>`;
    })
    .join("\n");
}

function genericRowsHtml(members: MemberEval[]): string {
  return members
    .map((m) => {
      const id = escapeHtml(m.eval_id);
      const title = escapeHtml(m.title);
      const quote =
        m.input_truncated && m.input_truncated !== m.title
          ? `<p class="quote">${escapeHtml(m.input_truncated)}</p>`
          : "";
      const acceptChecked = m.score_how === "code" ? " checked" : "";
      const rejectChecked = m.score_how === "code" ? "" : " checked";
      return `<li class="card">
  <p class="claim">${title}</p>
  ${quote}
  <div class="choices">
    <label><input type="radio" name="decision_${id}" value="accept"${acceptChecked}> Accept</label>
    <label><input type="radio" name="decision_${id}" value="reject"${rejectChecked}> Reject</label>
  </div>
</li>`;
    })
    .join("\n");
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

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
}

function parseDecisions(body: Record<string, unknown>): {
  evalSetId: string | undefined;
  token: string | undefined;
  accept: string[];
  reject: string[];
} {
  const evalSetId = asString(body.eval_set_id);
  const token = asString(body.token);
  const accept = asStringArray(body.accept);
  const reject = asStringArray(body.reject);
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith("decision_")) {
      continue;
    }
    const evalId = key.slice("decision_".length);
    const decision = asString(value);
    if (decision === "accept") {
      accept.push(evalId);
    } else if (decision === "reject") {
      reject.push(evalId);
    }
  }
  return { evalSetId, token, accept, reject };
}

export async function registerAccept(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
): Promise<void> {
  registerFormParser(app);

  app.get("/accept", async (request, reply) => {
    const query = request.query as {
      eval_set_id?: string;
      token?: string;
    };
    const evalSetId = query.eval_set_id;
    if (!evalSetId) {
      return reply.code(400).send("eval_set_id is required");
    }
    if (!verifyAcceptToken(apiKey, evalSetId, query.token)) {
      return reply.code(401).send("unauthorized");
    }
    const set = getEvalSet(db, evalSetId);
    if (!set) {
      return reply.code(404).send("eval set not found");
    }
    const members = listMembers(db, evalSetId);
    const html = renderAcceptPage({
      evalSetId,
      version: set.version,
      token: query.token ?? "",
      members,
      banner: "",
      jobDescription: getJobDescription(db, evalSetId) ?? "",
    });
    return reply.type("text/html").send(html);
  });

  app.post("/accept", async (request, reply) => {
    const body =
      request.body !== null &&
      typeof request.body === "object" &&
      !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
    const parsed = parseDecisions(body);
    if (!parsed.evalSetId) {
      return reply.code(400).send({ error: "eval_set_id is required" });
    }
    if (!verifyAcceptToken(apiKey, parsed.evalSetId, parsed.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const set = getEvalSet(db, parsed.evalSetId);
    if (!set) {
      return reply.code(404).send({ error: "eval set not found" });
    }

    applyAcceptDecisions(db, parsed.evalSetId, parsed.accept, parsed.reject);
    const members = listMembers(db, parsed.evalSetId);
    const next_action = nextActionForSet(
      members,
      set.project_id,
      parsed.evalSetId,
    );
    const result = {
      eval_set_id: parsed.evalSetId,
      version: set.version,
      next_action,
    };

    const wantsJson =
      String(request.headers["content-type"] ?? "").includes("application/json") ||
      String(request.headers.accept ?? "").includes("application/json");
    if (wantsJson) {
      return reply.code(200).send(result);
    }

    const html = renderAcceptPage({
      evalSetId: parsed.evalSetId,
      version: set.version,
      token: parsed.token ?? "",
      members,
      banner: `<p>Saved. next_action.tool = ${escapeHtml(next_action.tool ?? "")}</p>`,
      jobDescription: getJobDescription(db, parsed.evalSetId) ?? "",
    });
    return reply.type("text/html").send(html);
  });
}
