import type Database from "better-sqlite3";
import { jobUnclearError, projectNotFoundError, suiteNotFoundError } from "../errors.js";
import { copyEvalSetForward } from "../eval-set-copy.js";
import {
  createEvalSetVersion1,
  getEvalSet,
  getIdempotentResponse,
  insertDraftEvals,
  listMembers,
  nextActionForSet,
  storeIdempotentResponse,
  type DraftEval,
} from "../eval-set.js";
import { newJobId, newProjectId } from "../ids.js";
import { isJsonObjectJob, jsonObjectDrafts } from "../job-types/json_object.js";
import { draftsFromWhatGoodMeans } from "../job-types/unknown.js";
import { projectExists } from "../keys.js";
import {
  generateEvalSuiteOutputSchema,
  type generateEvalSuiteInputSchema,
} from "./schema.js";
import type { ToolHandler } from "../dispatch.js";
import type { z } from "zod";

type GenerateInput = z.infer<typeof generateEvalSuiteInputSchema>;

const SMOKE_MAX = 15;
const STANDARD_MAX = 60;

function capDrafts(drafts: DraftEval[], size: "smoke" | "standard" | undefined): DraftEval[] {
  const max = size === "smoke" ? SMOKE_MAX : STANDARD_MAX;
  return drafts.slice(0, max);
}

function ensureProject(
  db: Database.Database,
  projectId: string | null | undefined,
): { ok: true; projectId: string } | { ok: false; status: number; body: unknown } {
  if (projectId == null || projectId === "") {
    const id = newProjectId();
    db.prepare("INSERT INTO projects (id, created_at) VALUES (?, ?)").run(
      id,
      new Date().toISOString(),
    );
    return { ok: true, projectId: id };
  }
  if (!projectExists(db, projectId)) {
    return {
      ok: false,
      status: 404,
      body: projectNotFoundError(projectId),
    };
  }
  return { ok: true, projectId };
}

function buildDrafts(input: GenerateInput): DraftEval[] | null {
  const description = input.description;
  const sampleFiles = input.sample_files;
  if (isJsonObjectJob(description)) {
    return jsonObjectDrafts({
      description: description ?? "",
      sampleFiles,
    });
  }
  if (input.what_good_means != null) {
    const drafts = draftsFromWhatGoodMeans(input.what_good_means);
    if (sampleFiles && sampleFiles.length > 0) {
      for (const file of sampleFiles) {
        drafts.push({
          title: `Sample ${file.path}`,
          score_how: "code",
          status: "draft",
          program_check: { kind: "fixture", expected: { path: file.path } },
          input_truncated: file.content.slice(0, 500),
        });
      }
    }
    return drafts;
  }
  return null;
}

export const handleGenerateEvalSuite: ToolHandler = (body, ctx) => {
  const db = ctx.db;
  if (!db) {
    throw new Error("generate_eval_suite requires db on ToolContext");
  }

  const input = body as GenerateInput;
  const existing = getIdempotentResponse(
    db,
    "generate_eval_suite",
    input.idempotency_key,
  );
  if (existing) {
    return existing;
  }

  const intent = input.intent ?? "new_feature";
  if (intent === "add_feature") {
    const sourceEvalSetId = input.eval_set_id!;
    const sourceSet = getEvalSet(db, sourceEvalSetId);
    if (!sourceSet) {
      return { status: 404, body: suiteNotFoundError(sourceEvalSetId) };
    }

    const projectId = input.project_id ?? sourceSet.project_id;
    if (
      input.project_id != null &&
      input.project_id !== "" &&
      input.project_id !== sourceSet.project_id
    ) {
      return { status: 404, body: suiteNotFoundError(sourceEvalSetId) };
    }
    if (!projectExists(db, projectId)) {
      return { status: 404, body: projectNotFoundError(projectId) };
    }

    const draftsRaw = buildDrafts(input);
    if (draftsRaw == null || draftsRaw.length === 0) {
      return { status: 400, body: jobUnclearError() };
    }
    const drafts = capDrafts(draftsRaw, input.size);

    let copied;
    try {
      copied = copyEvalSetForward(db, {
        projectId,
        sourceEvalSetId,
      });
    } catch {
      return { status: 404, body: suiteNotFoundError(sourceEvalSetId) };
    }

    const run = db.transaction(() => {
      insertDraftEvals(db, copied.newEvalSetId, drafts);

      const jobRow = db
        .prepare(`SELECT job_id FROM eval_sets WHERE id = ?`)
        .get(copied.newEvalSetId) as { job_id: string | null };
      const jobId = jobRow?.job_id ?? "";

      const members = listMembers(db, copied.newEvalSetId);
      const nCode = members.filter((e) => e.score_how === "code").length;
      const nPerson = members.filter((e) => e.score_how === "person").length;
      const nDraft = members.filter((e) => e.status === "draft").length;
      const nTrusted = members.filter((e) => e.status === "trusted").length;
      const preview = members.slice(0, 5).map((e) => ({
        eval_id: e.eval_id,
        title: e.title,
        score_how: e.score_how,
        status: e.status,
      }));
      const next = nextActionForSet(members, projectId, copied.newEvalSetId);

      const output = generateEvalSuiteOutputSchema.parse({
        project_id: projectId,
        job_id: jobId,
        eval_set_id: copied.newEvalSetId,
        version: copied.version,
        evals: preview,
        n_code: nCode,
        n_person: nPerson,
        n_draft: nDraft,
        counts: {
          draft: nDraft,
          code: nCode,
          needs_person: nPerson,
          trusted: nTrusted,
          total: members.length,
        },
        mark_url: null,
        next_action: next,
      });

      storeIdempotentResponse(
        db,
        "generate_eval_suite",
        input.idempotency_key,
        200,
        output,
        projectId,
      );

      return { status: 200, body: output };
    });
    return run();
  }

  const draftsRaw = buildDrafts(input);
  if (draftsRaw == null || draftsRaw.length === 0) {
    return { status: 400, body: jobUnclearError() };
  }
  const drafts = capDrafts(draftsRaw, input.size);

  const run = db.transaction(() => {
    const project = ensureProject(db, input.project_id);
    if (!project.ok) {
      return project;
    }
    const projectId = project.projectId;
    const jobId = newJobId();
    const description =
      input.description ??
      JSON.stringify(input.what_good_means);
    db.prepare(
      `INSERT INTO jobs (id, project_id, description, limits, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      projectId,
      description,
      input.limits ? JSON.stringify(input.limits) : null,
      new Date().toISOString(),
    );

    const createdSet = createEvalSetVersion1(db, {
      projectId,
      jobId,
      drafts,
    });

    const nCode = createdSet.evals.filter((e) => e.score_how === "code").length;
    const nPerson = createdSet.evals.filter((e) => e.score_how === "person").length;
    const nDraft = createdSet.evals.filter((e) => e.status === "draft").length;
    const preview = createdSet.evals.slice(0, 5).map((e) => ({
      eval_id: e.eval_id,
      title: e.title,
      score_how: e.score_how,
      status: e.status,
    }));
    const next = nextActionForSet(
      createdSet.evals.map((e) => ({
        ...e,
        program_check: null,
        input_truncated: "",
      })),
      projectId,
      createdSet.evalSetId,
    );

    const output = generateEvalSuiteOutputSchema.parse({
      project_id: projectId,
      job_id: jobId,
      eval_set_id: createdSet.evalSetId,
      version: createdSet.version,
      evals: preview,
      n_code: nCode,
      n_person: nPerson,
      n_draft: nDraft,
      counts: {
        draft: nDraft,
        code: nCode,
        needs_person: nPerson,
        trusted: createdSet.evals.filter((e) => e.status === "trusted").length,
        total: createdSet.evals.length,
      },
      mark_url: null,
      next_action: next,
    });

    storeIdempotentResponse(
      db,
      "generate_eval_suite",
      input.idempotency_key,
      200,
      output,
      projectId,
    );

    return { ok: true as const, status: 200, body: output };
  });
  const created = run();

  if (!created.ok) {
    return { status: created.status, body: created.body };
  }
  return { status: created.status, body: created.body };
};
