import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import {
  applyAcceptDecisions,
  getEvalSet,
  listMembers,
  nextActionForSet,
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
  rowsHtml: string;
  banner: string;
}): string {
  const template = readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{EVAL_SET_ID}}", escapeHtml(opts.evalSetId))
    .replaceAll("{{VERSION}}", String(opts.version))
    .replaceAll("{{TOKEN}}", escapeHtml(opts.token))
    .replace("{{EVAL_ROWS}}", opts.rowsHtml)
    .replace("{{BANNER}}", opts.banner);
}

function evalRowsHtml(
  members: Array<{
    eval_id: string;
    title: string;
    score_how: string;
    status: string;
  }>,
): string {
  if (members.length === 0) {
    return "<li>No drafts left on this eval set.</li>";
  }
  return members
    .map((m) => {
      const id = escapeHtml(m.eval_id);
      return `<li>
  <p><strong>${escapeHtml(m.title)}</strong></p>
  <p class="meta">${escapeHtml(m.score_how)} eval · ${escapeHtml(m.status)}</p>
  <label><input type="radio" name="decision_${id}" value="accept"${m.score_how === "code" ? " checked" : ""}> Accept</label>
  <label><input type="radio" name="decision_${id}" value="reject"${m.score_how === "code" ? "" : " checked"}> Reject</label>
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
      rowsHtml: evalRowsHtml(members),
      banner: "",
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
      rowsHtml: evalRowsHtml(members),
      banner: `<p>Saved. Kept code evals are trusted. Rejected drafts were dropped. next_action.tool = ${escapeHtml(next_action.tool ?? "")}</p>`,
    });
    return reply.type("text/html").send(html);
  });
}
