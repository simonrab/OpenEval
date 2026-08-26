import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { listMembers } from "../eval-set.js";
import { registerFormParser } from "../routes/form-parser.js";
import {
  markFromFormBody,
  parseFormRenderMeta,
  type FormRenderMeta,
  type MarkFormType,
  type MarkPayload,
  type PassFailChoice,
  type StoredMark,
} from "./forms.js";
import {
  countRemainingQueue,
  ensureEvalFormMeta,
  ensureProjectPeople,
  getJobGoodMeans,
  getMarkForPerson,
  listMarksForEval,
  nextQueueEval,
  submitMark,
  type PersonRow,
} from "./store.js";
import { verifyMarkToken } from "./tokens.js";

const screenTemplatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "screen.html",
);
const thirdTemplatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "third.html",
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rubricRadio(
  name: string,
  label: string,
  selected?: PassFailChoice,
): string {
  const choices: PassFailChoice[] = ["pass", "fail", "na"];
  const inputs = choices
    .map((value) => {
      const checked = selected === value ? " checked" : "";
      const required = value === "pass" ? " required" : "";
      return `<label><input type="radio" name="${escapeHtml(name)}" value="${value}"${checked}${required}> ${value}</label>`;
    })
    .join("\n  ");
  return `<fieldset>
  <legend>${escapeHtml(label)}</legend>
  ${inputs}
</fieldset>`;
}

function renderFormFields(
  formType: MarkFormType,
  draftMark: string | null,
  meta: FormRenderMeta,
): string {
  if (formType === "pass_fail") {
    const textDefault =
      draftMark != null && !draftMark.trimStart().startsWith("{")
        ? draftMark
        : "";
    return `<fieldset>
  <legend>Pass / fail</legend>
  <label><input type="radio" name="pass_fail" value="pass" required> Pass</label>
  <label><input type="radio" name="pass_fail" value="fail"> Fail</label>
  <label><input type="radio" name="pass_fail" value="na"> Not applicable</label>
  <label>Expected text (optional)
    <textarea name="expected_text">${escapeHtml(textDefault)}</textarea>
  </label>
</fieldset>`;
  }
  if (formType === "text") {
    const textDefault =
      draftMark != null && !draftMark.trimStart().startsWith("{")
        ? draftMark
        : "";
    return `<label>Expected text
  <textarea name="expected_text" required>${escapeHtml(textDefault)}</textarea>
</label>`;
  }
  if (formType === "fields") {
    const rows = meta.fieldNames
      .map(
        (name) =>
          `<label>${escapeHtml(name)}
  <input type="text" name="field_${escapeHtml(name)}" value="${escapeHtml(meta.fieldDefaults[name] ?? "")}" required>
</label>`,
      )
      .join("\n");
    return `<fieldset>
  <legend>Fields</legend>
${rows}
</fieldset>`;
  }
  if (formType === "rubric") {
    const rows = meta.rubricNames
      .map((name) => rubricRadio(`rubric_${name}`, name, meta.rubricDefaults[name]))
      .join("\n");
    return `<fieldset>
  <legend>Rubric</legend>
${rows}
</fieldset>`;
  }
  if (formType === "tool") {
    return `<fieldset>
  <legend>Expected tool call</legend>
  <label>Tool name
    <input type="text" name="tool_name" value="${escapeHtml(meta.toolNameDefault)}" required>
  </label>
  <label>Tool args (JSON)
    <textarea name="tool_args">${escapeHtml(meta.toolArgsDefault)}</textarea>
  </label>
</fieldset>`;
  }
  return `<p>Form type ${escapeHtml(formType)} is not wired on this screen yet.</p>`;
}

function loadFormRenderMeta(
  db: Database.Database,
  evalId: string,
  formType: MarkFormType,
): FormRenderMeta {
  const row = db
    .prepare(`SELECT draft_mark, form_spec FROM evals WHERE id = ?`)
    .get(evalId) as { draft_mark: string | null; form_spec: string | null } | undefined;
  return parseFormRenderMeta(
    row?.draft_mark ?? null,
    row?.form_spec ?? null,
    formType,
  );
}

function draftSection(draftMark: string | null): string {
  if (!draftMark) {
    return "";
  }
  return `<section class="box draft">
  <h2>Suggested draft</h2>
  <p class="meta">This is a suggestion, not the right answer.</p>
  <pre>${escapeHtml(draftMark)}</pre>
</section>`;
}

function formatMarkSummary(mark: StoredMark): string {
  if ("kind" in mark && mark.kind === "cannot_mark") {
    return `Cannot mark: ${escapeHtml(mark.reason)}`;
  }
  const payload = mark as MarkPayload;
  const parts: string[] = [`form: ${payload.form_type}`];
  if (payload.pass_fail) {
    parts.push(`pass_fail: ${payload.pass_fail}`);
  }
  if (payload.expected_text) {
    parts.push(`text: ${payload.expected_text}`);
  }
  if (payload.fields) {
    parts.push(
      `fields: ${Object.entries(payload.fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    );
  }
  if (payload.rubric) {
    parts.push(
      `rubric: ${Object.entries(payload.rubric)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`,
    );
  }
  if (payload.tool) {
    parts.push(`tool: ${payload.tool.name}`);
  }
  return escapeHtml(parts.join(" · "));
}

function personOptions(people: PersonRow[], excludeIds: string[]): string {
  return people
    .filter((p) => p.slot !== "third" && !excludeIds.includes(p.id))
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}">${escapeHtml(p.display_name)}</option>`,
    )
    .join("\n");
}

function renderScreen(opts: {
  evalSetId: string;
  evalId: string;
  token: string;
  evalsLeft: number;
  goodMeans: { how_it_should_behave: string; success: string; must_never: string };
  input: string;
  draftMark: string | null;
  formType: MarkFormType;
  formMeta: FormRenderMeta;
  personOptionsHtml: string;
  banner: string;
}): string {
  const template = readFileSync(screenTemplatePath, "utf8");
  return template
    .replaceAll("{{EVAL_SET_ID}}", escapeHtml(opts.evalSetId))
    .replaceAll("{{EVAL_ID}}", escapeHtml(opts.evalId))
    .replaceAll("{{TOKEN}}", escapeHtml(opts.token))
    .replace("{{EVALS_LEFT}}", String(opts.evalsLeft))
    .replace("{{HOW_BEHAVE}}", escapeHtml(opts.goodMeans.how_it_should_behave))
    .replace("{{SUCCESS}}", escapeHtml(opts.goodMeans.success))
    .replace("{{MUST_NEVER}}", escapeHtml(opts.goodMeans.must_never))
    .replace("{{INPUT}}", escapeHtml(opts.input))
    .replace("{{DRAFT_SECTION}}", draftSection(opts.draftMark))
    .replace("{{FORM_FIELDS}}", renderFormFields(opts.formType, opts.draftMark, opts.formMeta))
    .replace("{{PERSON_OPTIONS}}", opts.personOptionsHtml)
    .replace("{{BANNER}}", opts.banner);
}

function renderThird(opts: {
  evalSetId: string;
  evalId: string;
  token: string;
  personId: string;
  goodMeans: { how_it_should_behave: string; success: string; must_never: string };
  input: string;
  draftMark: string | null;
  formType: MarkFormType;
  formMeta: FormRenderMeta;
  priorMarksHtml: string;
  pickOptions: string;
  banner: string;
}): string {
  const template = readFileSync(thirdTemplatePath, "utf8");
  return template
    .replaceAll("{{EVAL_SET_ID}}", escapeHtml(opts.evalSetId))
    .replaceAll("{{EVAL_ID}}", escapeHtml(opts.evalId))
    .replaceAll("{{TOKEN}}", escapeHtml(opts.token))
    .replaceAll("{{PERSON_ID}}", escapeHtml(opts.personId))
    .replace("{{HOW_BEHAVE}}", escapeHtml(opts.goodMeans.how_it_should_behave))
    .replace("{{SUCCESS}}", escapeHtml(opts.goodMeans.success))
    .replace("{{MUST_NEVER}}", escapeHtml(opts.goodMeans.must_never))
    .replace("{{INPUT}}", escapeHtml(opts.input))
    .replace("{{DRAFT_SECTION}}", draftSection(opts.draftMark))
    .replace("{{FORM_FIELDS}}", renderFormFields(opts.formType, opts.draftMark, opts.formMeta))
    .replace("{{PRIOR_MARKS}}", opts.priorMarksHtml)
    .replace("{{PICK_OPTIONS}}", opts.pickOptions)
    .replace("{{BANNER}}", opts.banner);
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

export async function registerMarkRoutes(
  app: FastifyInstance,
  db: Database.Database,
  apiKey: string,
): Promise<void> {
  registerFormParser(app);

  app.get("/mark", async (request, reply) => {
    const query = request.query as {
      eval_set_id?: string;
      token?: string;
      person_id?: string;
    };
    const evalSetId = query.eval_set_id;
    if (!evalSetId) {
      return reply.code(400).send("eval_set_id is required");
    }
    if (!verifyMarkToken(apiKey, evalSetId, query.token)) {
      return reply.code(401).send("unauthorized");
    }

    const next = nextQueueEval(db, evalSetId);
    if (!next) {
      return reply.code(200).send("<p>Mark queue is empty for this eval set.</p>");
    }

    if (next.state === "disagree") {
      const people = ensureProjectPeople(
        db,
        (
          db
            .prepare("SELECT project_id FROM eval_sets WHERE id = ?")
            .get(evalSetId) as { project_id: string }
        ).project_id,
      );
      const third = people.find((p) => p.slot === "third");
      if (!third) {
        return reply.code(500).send("third person missing");
      }
      const url = `/mark/third?eval_set_id=${encodeURIComponent(evalSetId)}&eval_id=${encodeURIComponent(next.eval_id)}&token=${encodeURIComponent(query.token ?? "")}&person_id=${encodeURIComponent(third.id)}`;
      return reply.redirect(url);
    }

    const member = listMembers(db, evalSetId).find((m) => m.eval_id === next.eval_id);
    if (!member) {
      return reply.code(404).send("eval not found");
    }

    const set = db
      .prepare("SELECT project_id FROM eval_sets WHERE id = ?")
      .get(evalSetId) as { project_id: string };
    const people = ensureProjectPeople(db, set.project_id);
    const markedIds = listMarksForEval(db, evalSetId, next.eval_id).map(
      (m) => m.person_id,
    );
    const goodMeans =
      getJobGoodMeans(db, evalSetId) ?? {
        how_it_should_behave: "",
        success: "",
        must_never: "",
      };
    const row = db
      .prepare(
        `SELECT draft_mark, input_truncated, score_how FROM evals WHERE id = ?`,
      )
      .get(next.eval_id) as {
      draft_mark: string | null;
      input_truncated: string;
      score_how: "code" | "person";
    };
    const formType = ensureEvalFormMeta(db, next.eval_id, row.score_how);
    const formMeta = loadFormRenderMeta(db, next.eval_id, formType);

    const html = renderScreen({
      evalSetId,
      evalId: next.eval_id,
      token: query.token ?? "",
      evalsLeft: countRemainingQueue(db, evalSetId),
      goodMeans,
      input: row.input_truncated,
      draftMark: row.draft_mark,
      formType,
      formMeta,
      personOptionsHtml: personOptions(people, markedIds),
      banner: "",
    });
    return reply.type("text/html").send(html);
  });

  app.post("/mark/cannot", async (request, reply) => {
    const body = asRecord(request.body);
    const evalSetId = asString(body.eval_set_id);
    const evalId = asString(body.eval_id);
    const token = asString(body.token);
    const personId = asString(body.person_id);
    const reason = asString(body.reason) ?? asString(body.why);
    if (!evalSetId || !evalId || !personId || !reason) {
      return reply.code(400).send({ error: "missing fields" });
    }
    if (!verifyMarkToken(apiKey, evalSetId, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const result = submitMark(db, {
      evalSetId,
      evalId,
      personId,
      mark: { kind: "cannot_mark", reason },
    });
    if (!result.ok) {
      return reply.code(400).send({ error: result.error });
    }
    return reply.code(200).send({ ok: true, state: result.state });
  });

  app.post("/mark", async (request, reply) => {
    const body = asRecord(request.body);
    const evalSetId = asString(body.eval_set_id);
    const evalId = asString(body.eval_id);
    const token = asString(body.token);
    const personId = asString(body.person_id);
    if (!evalSetId || !evalId || !personId) {
      return reply.code(400).send({ error: "missing fields" });
    }
    if (!verifyMarkToken(apiKey, evalSetId, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const member = listMembers(db, evalSetId).find((m) => m.eval_id === evalId);
    if (!member || member.score_how !== "person") {
      return reply.code(400).send({ error: "not a person eval" });
    }

    const formType = ensureEvalFormMeta(db, evalId, member.score_how);
    const parsed = markFromFormBody(formType, body);
    if (!parsed) {
      return reply.code(400).send({ error: "invalid mark" });
    }

    const result = submitMark(db, {
      evalSetId,
      evalId,
      personId,
      mark: parsed,
    });
    if (!result.ok) {
      return reply.code(400).send({ error: result.error });
    }

    const wantsJson =
      String(request.headers["content-type"] ?? "").includes("application/json") ||
      String(request.headers.accept ?? "").includes("application/json");
    if (wantsJson) {
      return reply.code(200).send({ ok: true, state: result.state, trusted: result.trusted });
    }

    const goodMeans =
      getJobGoodMeans(db, evalSetId) ?? {
        how_it_should_behave: "",
        success: "",
        must_never: "",
      };
    const row = db
      .prepare(`SELECT draft_mark, input_truncated FROM evals WHERE id = ?`)
      .get(evalId) as { draft_mark: string | null; input_truncated: string };
    const set = db
      .prepare("SELECT project_id FROM eval_sets WHERE id = ?")
      .get(evalSetId) as { project_id: string };
    const people = ensureProjectPeople(db, set.project_id);
    const formMeta = loadFormRenderMeta(db, evalId, formType);
    const html = renderScreen({
      evalSetId,
      evalId,
      token: token ?? "",
      evalsLeft: countRemainingQueue(db, evalSetId),
      goodMeans,
      input: row.input_truncated,
      draftMark: row.draft_mark,
      formType,
      formMeta,
      personOptionsHtml: personOptions(people, [personId]),
      banner: `<p>Saved. State: ${escapeHtml(result.state)}${result.trusted ? " · trusted" : ""}</p>`,
    });
    return reply.type("text/html").send(html);
  });

  app.get("/mark/third", async (request, reply) => {
    const query = request.query as {
      eval_set_id?: string;
      eval_id?: string;
      token?: string;
      person_id?: string;
    };
    const evalSetId = query.eval_set_id;
    const evalId = query.eval_id;
    if (!evalSetId || !evalId) {
      return reply.code(400).send("eval_set_id and eval_id are required");
    }
    if (!verifyMarkToken(apiKey, evalSetId, query.token)) {
      return reply.code(401).send("unauthorized");
    }

    const queue = db
      .prepare(
        `SELECT state FROM mark_queue WHERE eval_set_id = ? AND eval_id = ?`,
      )
      .get(evalSetId, evalId) as { state: string } | undefined;
    if (queue?.state !== "disagree") {
      return reply.code(400).send("not waiting for third person");
    }

    const set = db
      .prepare("SELECT project_id FROM eval_sets WHERE id = ?")
      .get(evalSetId) as { project_id: string };
    const people = ensureProjectPeople(db, set.project_id);
    const third = query.person_id
      ? people.find((p) => p.id === query.person_id && p.slot === "third")
      : people.find((p) => p.slot === "third");
    if (!third) {
      return reply.code(400).send("third person required");
    }
    if (getMarkForPerson(db, evalSetId, evalId, third.id)) {
      return reply.code(400).send("third already marked");
    }

    const prior = listMarksForEval(db, evalSetId, evalId).filter((m) => !m.is_third);
    const goodMeans =
      getJobGoodMeans(db, evalSetId) ?? {
        how_it_should_behave: "",
        success: "",
        must_never: "",
      };
    const row = db
      .prepare(
        `SELECT draft_mark, input_truncated, score_how FROM evals WHERE id = ?`,
      )
      .get(evalId) as {
      draft_mark: string | null;
      input_truncated: string;
      score_how: "code" | "person";
    };
    const formType = ensureEvalFormMeta(db, evalId, row.score_how);
    const formMeta = loadFormRenderMeta(db, evalId, formType);
    const priorHtml = prior
      .map((m) => {
        const person = people.find((p) => p.id === m.person_id);
        return `<div><strong>${escapeHtml(person?.display_name ?? m.person_id)}</strong><br>${formatMarkSummary(m.mark)}</div>`;
      })
      .join("");
    const pickOptions = prior
      .map((m) => {
        const person = people.find((p) => p.id === m.person_id);
        return `<option value="${escapeHtml(m.person_id)}">Trust ${escapeHtml(person?.display_name ?? m.person_id)}</option>`;
      })
      .join("\n");

    const html = renderThird({
      evalSetId,
      evalId,
      token: query.token ?? "",
      personId: third.id,
      goodMeans,
      input: row.input_truncated,
      draftMark: row.draft_mark,
      formType,
      formMeta,
      priorMarksHtml: priorHtml,
      pickOptions,
      banner: "",
    });
    return reply.type("text/html").send(html);
  });

  app.post("/mark/third", async (request, reply) => {
    const body = asRecord(request.body);
    const evalSetId = asString(body.eval_set_id);
    const evalId = asString(body.eval_id);
    const token = asString(body.token);
    const personId = asString(body.person_id);
    if (!evalSetId || !evalId || !personId) {
      return reply.code(400).send({ error: "missing fields" });
    }
    if (!verifyMarkToken(apiKey, evalSetId, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    if (body.action === "drop") {
      db.prepare(
        `UPDATE mark_queue SET state = 'dropped' WHERE eval_set_id = ? AND eval_id = ?`,
      ).run(evalSetId, evalId);
      return reply.code(200).send({ ok: true, state: "dropped" });
    }

    const pickPersonId = asString(body.pick_person_id);
    let mark: MarkPayload | null = null;
    if (pickPersonId) {
      const picked = getMarkForPerson(db, evalSetId, evalId, pickPersonId);
      if (!picked || "kind" in picked) {
        return reply.code(400).send({ error: "invalid pick" });
      }
      mark = picked as MarkPayload;
    } else {
      const member = listMembers(db, evalSetId).find((m) => m.eval_id === evalId);
      if (!member) {
        return reply.code(404).send({ error: "eval not found" });
      }
      const formType = ensureEvalFormMeta(db, evalId, member.score_how);
      const parsed = markFromFormBody(formType, body);
      if (!parsed || "kind" in parsed) {
        return reply.code(400).send({ error: "invalid mark" });
      }
      mark = parsed;
    }

    const result = submitMark(db, {
      evalSetId,
      evalId,
      personId,
      mark,
      isThird: true,
    });
    if (!result.ok) {
      return reply.code(400).send({ error: result.error });
    }
    return reply.code(200).send({ ok: true, state: result.state, trusted: result.trusted });
  });
}
