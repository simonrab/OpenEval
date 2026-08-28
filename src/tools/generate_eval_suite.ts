import type Database from "better-sqlite3";
import { invalidInputError, jobUnclearError, projectNotFoundError, suiteNotFoundError } from "../errors.js";
import { buildDraftPlan, type DraftPlan } from "../archetypes/drafts.js";
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
import { attachImagePdfFiles } from "../eval-files.js";
import { newJobId, newProjectId } from "../ids.js";
import { projectExists } from "../keys.js";
import { buildAcceptUrl, signAcceptToken } from "../routes/accept.js";
import {
  generateEvalSuiteOutputSchema,
  type generateEvalSuiteInputSchema,
} from "./schema.js";
import type { NextAction } from "./types.js";
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

function nextActionForAcceptUrl(
  acceptUrl: string,
  afterAccept: { tool: string; args: Record<string, unknown> },
): NextAction {
  return {
    tool: null,
    args: {
      accept_url: acceptUrl,
      after_accept_tool: afterAccept.tool,
      after_accept_args: afterAccept.args,
    },
    ask_human: "open accept_url",
  };
}

function planDrafts(input: GenerateInput): DraftPlan {
  const plan = buildDraftPlan(input);
  if (!plan.ok) {
    return plan;
  }
  return {
    ...plan,
    drafts: capDrafts(plan.drafts, input.size),
  };
}

function previewEvals(
  members: Array<{
    eval_id: string;
    title: string;
    score_how: "code" | "person";
    status: string;
    archetype_id: string | null;
    scorer_primitive: string | null;
  }>,
): Array<{
  eval_id: string;
  title: string;
  score_how: "code" | "person";
  status: string;
  archetype_id: string | null;
  scorer_primitive: string | null;
}> {
  return members.slice(0, 5).map((e) => ({
    eval_id: e.eval_id,
    title: e.title,
    score_how: e.score_how,
    status: e.status,
    archetype_id: e.archetype_id,
    scorer_primitive: e.scorer_primitive,
  }));
}

function mergeArchetypeIds(
  planned: string[],
  members: Array<{ archetype_id: string | null }>,
): string[] {
  return [
    ...new Set([
      ...planned,
      ...members.map((e) => e.archetype_id).filter((id): id is string => id != null),
    ]),
  ];
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
  const retireIds = input.retire_eval_ids ?? [];
  const retiring = retireIds.length > 0;
  if (intent === "add_feature" || retiring) {
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

    const draftPlan = planDrafts(input);
    if (!draftPlan.ok) {
      return { status: 400, body: invalidInputError(draftPlan.message) };
    }
    if (draftPlan.drafts.length === 0 && !retiring) {
      return { status: 400, body: jobUnclearError() };
    }
    const drafts = draftPlan.drafts;

    const sourceIds = new Set(
      listMembers(db, sourceEvalSetId).map((m) => m.eval_id),
    );
    for (const id of retireIds) {
      if (!sourceIds.has(id)) {
        return {
          status: 400,
          body: invalidInputError(`Unknown eval id ${id}`),
        };
      }
    }

    let copied;
    try {
      copied = copyEvalSetForward(db, {
        projectId,
        sourceEvalSetId,
        omitEvalIds: retireIds,
      });
    } catch {
      return { status: 404, body: suiteNotFoundError(sourceEvalSetId) };
    }

    const run = db.transaction(() => {
      insertDraftEvals(db, copied.newEvalSetId, drafts);
      const personIds = listMembers(db, copied.newEvalSetId)
        .filter((e) => e.score_how === "person")
        .map((e) => e.eval_id);
      attachImagePdfFiles(db, personIds, input.sample_files ?? []);

      const jobRow = db
        .prepare(`SELECT job_id FROM eval_sets WHERE id = ?`)
        .get(copied.newEvalSetId) as { job_id: string | null };
      const jobId = jobRow?.job_id ?? "";

      const members = listMembers(db, copied.newEvalSetId);
      const nCode = members.filter((e) => e.score_how === "code").length;
      const nPerson = members.filter((e) => e.score_how === "person").length;
      const nDraft = members.filter((e) => e.status === "draft").length;
      const nTrusted = members.filter((e) => e.status === "trusted").length;
      const preview = previewEvals(members);
      const afterAccept = nextActionForSet(members, projectId, copied.newEvalSetId);
      const acceptUrl = buildAcceptUrl(
        ctx.baseUrl ?? "http://127.0.0.1:3000",
        copied.newEvalSetId,
        signAcceptToken(ctx.apiKey ?? "", copied.newEvalSetId),
      );

      const output = generateEvalSuiteOutputSchema.parse({
        project_id: projectId,
        job_id: jobId,
        eval_set_id: copied.newEvalSetId,
        version: copied.version,
        evals: preview,
        n_code: nCode,
        n_person: nPerson,
        n_draft: nDraft,
        registry_version: draftPlan.registryVersion,
        archetype_ids_used: mergeArchetypeIds(draftPlan.archetypeIdsUsed, members),
        counts: {
          draft: nDraft,
          code: nCode,
          needs_person: nPerson,
          trusted: nTrusted,
          total: members.length,
        },
        accept_url: acceptUrl,
        mark_url: null,
        next_action: nextActionForAcceptUrl(acceptUrl, afterAccept),
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

  const draftPlan = planDrafts(input);
  if (!draftPlan.ok) {
    return { status: 400, body: invalidInputError(draftPlan.message) };
  }
  if (draftPlan.drafts.length === 0) {
    return { status: 400, body: jobUnclearError() };
  }
  const drafts = draftPlan.drafts;

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
    const limits = {
      ...(input.limits ?? {}),
      ...(input.system_prompt ? { system_prompt: input.system_prompt } : {}),
    };
    const limitsJson =
      Object.keys(limits).length > 0 ? JSON.stringify(limits) : null;
    db.prepare(
      `INSERT INTO jobs
        (id, project_id, description, limits, registry_version,
         archetype_plan, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      projectId,
      description ?? "",
      limitsJson,
      draftPlan.registryVersion,
      JSON.stringify(draftPlan.archetypePlan),
      new Date().toISOString(),
    );

    const createdSet = createEvalSetVersion1(db, {
      projectId,
      jobId,
      drafts,
    });
    attachImagePdfFiles(
      db,
      createdSet.evals.filter((e) => e.score_how === "person").map((e) => e.eval_id),
      input.sample_files ?? [],
    );

    const nCode = createdSet.evals.filter((e) => e.score_how === "code").length;
    const nPerson = createdSet.evals.filter((e) => e.score_how === "person").length;
    const nDraft = createdSet.evals.filter((e) => e.status === "draft").length;
    const preview = previewEvals(createdSet.evals);
    const next = nextActionForSet(
      createdSet.evals.map((e) => ({
        ...e,
        program_check: null,
        input_truncated: "",
        form_spec: null,
        evidence_json: null,
      })),
      projectId,
      createdSet.evalSetId,
    );
    const acceptUrl = buildAcceptUrl(
      ctx.baseUrl ?? "http://127.0.0.1:3000",
      createdSet.evalSetId,
      signAcceptToken(ctx.apiKey ?? "", createdSet.evalSetId),
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
      registry_version: draftPlan.registryVersion,
      archetype_ids_used: mergeArchetypeIds(
        draftPlan.archetypeIdsUsed,
        createdSet.evals,
      ),
      counts: {
        draft: nDraft,
        code: nCode,
        needs_person: nPerson,
        trusted: createdSet.evals.filter((e) => e.status === "trusted").length,
        total: createdSet.evals.length,
      },
      accept_url: acceptUrl,
      mark_url: null,
      next_action: nextActionForAcceptUrl(acceptUrl, next),
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
