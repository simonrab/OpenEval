import type Database from "better-sqlite3";
import { newEvalId, newEvalSetId } from "./ids.js";

export const INPUT_TRUNCATE = 500;

export type ProgramCheck = {
  kind:
    | "json_valid"
    | "tool_name"
    | "field_equals"
    | "must_not_contain"
    | "fixture";
  expected: unknown;
};

export type DraftFormType =
  | "pass_fail"
  | "rubric"
  | "fields"
  | "text"
  | "tool";

export type DraftEval = {
  title: string;
  score_how: "code" | "person";
  status: "draft";
  program_check: ProgramCheck | null;
  input_truncated: string;
  form_type?: DraftFormType;
  form_spec?: Record<string, unknown>;
};

export type StoredEval = {
  eval_id: string;
  title: string;
  score_how: "code" | "person";
  status: string;
};

export type ExampleLabel = {
  text: string;
  label: string;
};

export type MemberEval = StoredEval & {
  program_check: ProgramCheck | null;
  input_truncated: string;
  form_spec: ExampleLabel | null;
};

export function truncateInput(text: string, max = INPUT_TRUNCATE): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max);
}

export function getIdempotentResponse(
  db: Database.Database,
  toolName: string,
  key: string,
): { status: number; body: unknown } | null {
  const row = db
    .prepare(
      `SELECT status, response_json FROM idempotency
       WHERE tool_name = ? AND idempotency_key = ?`,
    )
    .get(toolName, key) as
    | { status: number; response_json: string }
    | undefined;
  if (!row) {
    return null;
  }
  return { status: row.status, body: JSON.parse(row.response_json) as unknown };
}

export function storeIdempotentResponse(
  db: Database.Database,
  toolName: string,
  key: string,
  status: number,
  body: unknown,
  projectId: string | null,
): void {
  db.prepare(
    `INSERT INTO idempotency
      (tool_name, idempotency_key, project_id, status, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    toolName,
    key,
    projectId,
    status,
    JSON.stringify(body),
    new Date().toISOString(),
  );
}

export function createEvalSetVersion1(
  db: Database.Database,
  opts: {
    projectId: string;
    jobId: string;
    drafts: DraftEval[];
  },
): { evalSetId: string; version: 1; evals: StoredEval[] } {
  const evalSetId = newEvalSetId();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO eval_sets
      (id, project_id, job_id, version, previous_eval_set_id, frozen_at, created_at)
     VALUES (?, ?, ?, 1, NULL, NULL, ?)`,
  ).run(evalSetId, opts.projectId, opts.jobId, createdAt);

  const evals: StoredEval[] = [];
  const insertEval = db.prepare(
    `INSERT INTO evals
      (id, title, score_how, status, program_check, input_truncated,
       form_type, form_spec, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMember = db.prepare(
    `INSERT INTO eval_set_members (eval_set_id, eval_id) VALUES (?, ?)`,
  );

  for (const draft of opts.drafts) {
    const evalId = newEvalId();
    insertEval.run(
      evalId,
      draft.title,
      draft.score_how,
      draft.status,
      draft.program_check ? JSON.stringify(draft.program_check) : null,
      draft.input_truncated,
      draft.form_type ?? null,
      draft.form_spec ? JSON.stringify(draft.form_spec) : null,
      createdAt,
    );
    insertMember.run(evalSetId, evalId);
    evals.push({
      eval_id: evalId,
      title: draft.title,
      score_how: draft.score_how,
      status: draft.status,
    });
  }

  return { evalSetId, version: 1, evals };
}

export function insertDraftEvals(
  db: Database.Database,
  evalSetId: string,
  drafts: DraftEval[],
): StoredEval[] {
  const createdAt = new Date().toISOString();
  const evals: StoredEval[] = [];
  const insertEval = db.prepare(
    `INSERT INTO evals
      (id, title, score_how, status, program_check, input_truncated,
       form_type, form_spec, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMember = db.prepare(
    `INSERT INTO eval_set_members (eval_set_id, eval_id) VALUES (?, ?)`,
  );

  for (const draft of drafts) {
    const evalId = newEvalId();
    insertEval.run(
      evalId,
      draft.title,
      draft.score_how,
      draft.status,
      draft.program_check ? JSON.stringify(draft.program_check) : null,
      draft.input_truncated,
      draft.form_type ?? null,
      draft.form_spec ? JSON.stringify(draft.form_spec) : null,
      createdAt,
    );
    insertMember.run(evalSetId, evalId);
    evals.push({
      eval_id: evalId,
      title: draft.title,
      score_how: draft.score_how,
      status: draft.status,
    });
  }

  return evals;
}

export function getEvalSet(
  db: Database.Database,
  evalSetId: string,
): {
  id: string;
  project_id: string;
  version: number;
} | null {
  const row = db
    .prepare(
      "SELECT id, project_id, version FROM eval_sets WHERE id = ?",
    )
    .get(evalSetId) as
    | { id: string; project_id: string; version: number }
    | undefined;
  return row ?? null;
}

export function getJobDescription(
  db: Database.Database,
  evalSetId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT j.description AS description
       FROM eval_sets es
       JOIN jobs j ON j.id = es.job_id
       WHERE es.id = ?`,
    )
    .get(evalSetId) as { description: string } | undefined;
  if (row == null || typeof row.description !== "string") {
    return null;
  }
  const text = row.description.trim();
  return text.length > 0 ? text : null;
}

export function listMembers(
  db: Database.Database,
  evalSetId: string,
): MemberEval[] {
  const rows = db
    .prepare(
      `SELECT e.id AS eval_id, e.title, e.score_how, e.status, e.program_check,
              e.input_truncated, e.form_spec
       FROM eval_set_members m
       JOIN evals e ON e.id = m.eval_id
       WHERE m.eval_set_id = ?
       ORDER BY e.created_at ASC, e.id ASC`,
    )
    .all(evalSetId) as Array<{
    eval_id: string;
    title: string;
    score_how: "code" | "person";
    status: string;
    program_check: string | null;
    input_truncated: string;
    form_spec: string | null;
  }>;
  return rows.map((row) => ({
    eval_id: row.eval_id,
    title: row.title,
    score_how: row.score_how,
    status: row.status,
    program_check: row.program_check
      ? (JSON.parse(row.program_check) as ProgramCheck)
      : null,
    input_truncated: row.input_truncated,
    form_spec: parseExampleLabel(row.form_spec),
  }));
}

function parseExampleLabel(raw: string | null): ExampleLabel | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const rec = parsed as Record<string, unknown>;
      const text = typeof rec.text === "string" ? rec.text : "";
      if (
        text.length > 0 &&
        typeof rec.label === "string" &&
        rec.label.length > 0
      ) {
        return { text, label: rec.label };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function applyAcceptDecisions(
  db: Database.Database,
  evalSetId: string,
  acceptIds: string[],
  rejectIds: string[],
): void {
  const trust = db.prepare(
    `UPDATE evals SET status = 'trusted'
     WHERE id = ? AND score_how = 'code'`,
  );
  const drop = db.prepare(
    `DELETE FROM eval_set_members WHERE eval_set_id = ? AND eval_id = ?`,
  );
  const tx = db.transaction(() => {
    for (const id of acceptIds) {
      trust.run(id);
    }
    for (const id of rejectIds) {
      drop.run(evalSetId, id);
    }
  });
  tx();
}

export function nextActionForSet(
  members: MemberEval[],
  projectId: string,
  evalSetId: string,
): {
  tool: "run_evals" | "queue_for_labeling";
  args: Record<string, unknown>;
  ask_human: null;
} {
  const nPerson = members.filter((m) => m.score_how === "person").length;
  if (nPerson > 0) {
    return {
      tool: "queue_for_labeling",
      args: { project_id: projectId, eval_set_id: evalSetId },
      ask_human: null,
    };
  }
  return {
    tool: "run_evals",
    args: { project_id: projectId, eval_set_id: evalSetId },
    ask_human: null,
  };
}
