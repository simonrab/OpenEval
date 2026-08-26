import type Database from "better-sqlite3";
import { marksAgree } from "./agreement.js";
import { newPersonId } from "../ids.js";
import {
  defaultFormType,
  isCannotMark,
  normalizeMarkPayload,
  parseMarkPayload,
  type MarkFormType,
  type MarkPayload,
  type StoredMark,
} from "./forms.js";

export type PersonRow = {
  id: string;
  display_name: string;
  slot: "marker1" | "marker2" | "third";
};

export type QueueState =
  | "waiting"
  | "one_mark"
  | "disagree"
  | "trusted"
  | "cannot_mark"
  | "dropped";

export function ensureProjectPeople(db: Database.Database, projectId: string): PersonRow[] {
  const existing = db
    .prepare(
      `SELECT id, display_name, slot FROM people
       WHERE project_id = ?
       ORDER BY slot ASC, id ASC`,
    )
    .all(projectId) as PersonRow[];
  if (existing.length >= 3) {
    return existing;
  }

  const createdAt = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO people (id, project_id, display_name, slot, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const slots: Array<{ slot: PersonRow["slot"]; name: string }> = [
    { slot: "marker1", name: "Marker 1" },
    { slot: "marker2", name: "Marker 2" },
    { slot: "third", name: "Third person" },
  ];
  const tx = db.transaction(() => {
    for (const { slot, name } of slots) {
      const found = existing.find((p) => p.slot === slot);
      if (!found) {
        insert.run(newPersonId(), projectId, name, slot, createdAt);
      }
    }
  });
  tx();

  return db
    .prepare(
      `SELECT id, display_name, slot FROM people
       WHERE project_id = ?
       ORDER BY slot ASC, id ASC`,
    )
    .all(projectId) as PersonRow[];
}

export function queuePersonEvals(
  db: Database.Database,
  evalSetId: string,
  evalIds: string[] | null | undefined,
): number {
  let targetIds = evalIds;
  if (targetIds == null) {
    const rows = db
      .prepare(
        `SELECT e.id AS eval_id
         FROM eval_set_members m
         JOIN evals e ON e.id = m.eval_id
         WHERE m.eval_set_id = ?
           AND e.score_how = 'person'
           AND e.status != 'trusted'`,
      )
      .all(evalSetId) as Array<{ eval_id: string }>;
    targetIds = rows.map((r) => r.eval_id);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO mark_queue (eval_set_id, eval_id, state, queued_at)
     VALUES (?, ?, 'waiting', ?)`,
  );
  const isPerson = db.prepare(
    `SELECT score_how, status FROM evals WHERE id = ?`,
  );
  const now = new Date().toISOString();
  let n = 0;
  const tx = db.transaction(() => {
    for (const evalId of targetIds ?? []) {
      const row = isPerson.get(evalId) as
        | { score_how: string; status: string }
        | undefined;
      if (!row || row.score_how !== "person" || row.status === "trusted") {
        continue;
      }
      const info = insert.run(evalSetId, evalId, now);
      if (info.changes > 0) {
        n += 1;
      }
    }
  });
  tx();
  return n;
}

export function countRemainingQueue(
  db: Database.Database,
  evalSetId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mark_queue
       WHERE eval_set_id = ?
         AND state IN ('waiting', 'one_mark', 'disagree')`,
    )
    .get(evalSetId) as { n: number };
  return row.n;
}

export function nextQueueEval(
  db: Database.Database,
  evalSetId: string,
): { eval_id: string; state: QueueState } | null {
  const row = db
    .prepare(
      `SELECT eval_id, state FROM mark_queue
       WHERE eval_set_id = ?
         AND state IN ('waiting', 'one_mark', 'disagree')
       ORDER BY queued_at ASC, eval_id ASC
       LIMIT 1`,
    )
    .get(evalSetId) as { eval_id: string; state: QueueState } | undefined;
  return row ?? null;
}

export function getMarkForPerson(
  db: Database.Database,
  evalSetId: string,
  evalId: string,
  personId: string,
): StoredMark | null {
  const row = db
    .prepare(
      `SELECT mark_json FROM marks
       WHERE eval_set_id = ? AND eval_id = ? AND person_id = ?`,
    )
    .get(evalSetId, evalId, personId) as { mark_json: string } | undefined;
  if (!row) {
    return null;
  }
  return JSON.parse(row.mark_json) as StoredMark;
}

export function listMarksForEval(
  db: Database.Database,
  evalSetId: string,
  evalId: string,
): Array<{ person_id: string; mark: StoredMark; is_third: boolean }> {
  const rows = db
    .prepare(
      `SELECT person_id, mark_json, is_third FROM marks
       WHERE eval_set_id = ? AND eval_id = ?
       ORDER BY created_at ASC`,
    )
    .all(evalSetId, evalId) as Array<{
    person_id: string;
    mark_json: string;
    is_third: number;
  }>;
  return rows.map((r) => ({
    person_id: r.person_id,
    mark: JSON.parse(r.mark_json) as StoredMark,
    is_third: r.is_third === 1,
  }));
}

function setQueueState(
  db: Database.Database,
  evalSetId: string,
  evalId: string,
  state: QueueState,
): void {
  db.prepare(
    `UPDATE mark_queue SET state = ? WHERE eval_set_id = ? AND eval_id = ?`,
  ).run(state, evalSetId, evalId);
}

function trustEval(
  db: Database.Database,
  evalId: string,
  trustedMark: MarkPayload,
): void {
  db.prepare(
    `UPDATE evals SET status = 'trusted', trusted_mark = ? WHERE id = ?`,
  ).run(JSON.stringify(normalizeMarkPayload(trustedMark)), evalId);
}

export type SubmitMarkResult =
  | { ok: true; state: QueueState; trusted: boolean }
  | { ok: false; error: string };

export function submitMark(
  db: Database.Database,
  input: {
    evalSetId: string;
    evalId: string;
    personId: string;
    mark: StoredMark;
    isThird?: boolean;
  },
): SubmitMarkResult {
  const existing = getMarkForPerson(
    db,
    input.evalSetId,
    input.evalId,
    input.personId,
  );
  if (existing != null) {
    return { ok: false, error: "already marked" };
  }

  const people = db
    .prepare(`SELECT slot FROM people WHERE id = ?`)
    .get(input.personId) as { slot: string } | undefined;
  if (!people) {
    return { ok: false, error: "unknown person" };
  }

  const priorMarks = listMarksForEval(db, input.evalSetId, input.evalId);
  const markerIds = priorMarks
    .filter((m) => !m.is_third)
    .map((m) => m.person_id);

  if (input.isThird) {
    if (people.slot !== "third") {
      return { ok: false, error: "not a third person" };
    }
    if (markerIds.includes(input.personId)) {
      return { ok: false, error: "third cannot have marked already" };
    }
    const queue = db
      .prepare(
        `SELECT state FROM mark_queue WHERE eval_set_id = ? AND eval_id = ?`,
      )
      .get(input.evalSetId, input.evalId) as { state: QueueState } | undefined;
    if (queue?.state !== "disagree") {
      return { ok: false, error: "not waiting for third" };
    }
  } else if (people.slot === "third" && !input.isThird) {
    return { ok: false, error: "third must use third screen" };
  }

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO marks (eval_set_id, eval_id, person_id, mark_json, is_third, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.evalSetId,
      input.evalId,
      input.personId,
      JSON.stringify(input.mark),
      input.isThird ? 1 : 0,
      now,
    );

    if (isCannotMark(input.mark)) {
      setQueueState(db, input.evalSetId, input.evalId, "cannot_mark");
      return;
    }

    const payload = input.mark as MarkPayload;

    if (input.isThird) {
      trustEval(db, input.evalId, payload);
      setQueueState(db, input.evalSetId, input.evalId, "trusted");
      return;
    }

    const regularMarks = listMarksForEval(db, input.evalSetId, input.evalId).filter(
      (m) => !m.is_third && !isCannotMark(m.mark),
    );

    if (regularMarks.length === 1) {
      setQueueState(db, input.evalSetId, input.evalId, "one_mark");
      return;
    }

    if (regularMarks.length >= 2) {
      const a = parseMarkPayload(regularMarks[0]!.mark);
      const b = parseMarkPayload(regularMarks[1]!.mark);
      if (a && b) {
        const agreement = marksAgree(a, b);
        if (agreement.agree) {
          trustEval(db, input.evalId, a);
          setQueueState(db, input.evalSetId, input.evalId, "trusted");
        } else {
          setQueueState(db, input.evalSetId, input.evalId, "disagree");
        }
      }
    }
  });

  tx();

  const stateRow = db
    .prepare(
      `SELECT state FROM mark_queue WHERE eval_set_id = ? AND eval_id = ?`,
    )
    .get(input.evalSetId, input.evalId) as { state: QueueState } | undefined;
  const state = stateRow?.state ?? "waiting";
  return { ok: true, state, trusted: state === "trusted" };
}

export function computeLabelCounts(
  db: Database.Database,
  evalSetId: string,
): {
  draft: number;
  code: number;
  waiting_for_person: number;
  trusted: number;
  need_third_person: number;
} {
  const members = db
    .prepare(
      `SELECT e.score_how, e.status
       FROM eval_set_members m
       JOIN evals e ON e.id = m.eval_id
       WHERE m.eval_set_id = ?`,
    )
    .all(evalSetId) as Array<{ score_how: string; status: string }>;

  let draft = 0;
  let code = 0;
  let trusted = 0;
  for (const m of members) {
    if (m.status === "draft") {
      draft += 1;
    }
    if (m.score_how === "code") {
      code += 1;
    }
    if (m.status === "trusted") {
      trusted += 1;
    }
  }

  const queueRows = db
    .prepare(
      `SELECT state FROM mark_queue WHERE eval_set_id = ?`,
    )
    .all(evalSetId) as Array<{ state: QueueState }>;

  let waiting_for_person = 0;
  let need_third_person = 0;
  for (const q of queueRows) {
    if (q.state === "waiting" || q.state === "one_mark") {
      waiting_for_person += 1;
    }
    if (q.state === "disagree") {
      need_third_person += 1;
      waiting_for_person += 1;
    }
  }

  return {
    draft,
    code,
    waiting_for_person,
    trusted,
    need_third_person,
  };
}

export function hasActiveMarkQueue(
  db: Database.Database,
  evalSetId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mark_queue
       WHERE eval_set_id = ?
         AND state IN ('waiting', 'one_mark', 'disagree')`,
    )
    .get(evalSetId) as { n: number };
  return row.n > 0;
}

export function ensureEvalFormMeta(
  db: Database.Database,
  evalId: string,
  scoreHow: "code" | "person",
): MarkFormType {
  const row = db
    .prepare(`SELECT form_type FROM evals WHERE id = ?`)
    .get(evalId) as { form_type: string | null } | undefined;
  if (row?.form_type) {
    return row.form_type as MarkFormType;
  }
  const formType = defaultFormType(scoreHow);
  db.prepare(`UPDATE evals SET form_type = ? WHERE id = ?`).run(formType, evalId);
  return formType;
}

export function getJobGoodMeans(
  db: Database.Database,
  evalSetId: string,
): {
  how_it_should_behave: string;
  success: string;
  must_never: string;
} | null {
  const row = db
    .prepare(
      `SELECT j.description FROM eval_sets es
       JOIN jobs j ON j.id = es.job_id
       WHERE es.id = ?`,
    )
    .get(evalSetId) as { description: string } | undefined;
  if (!row) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.description) as {
      how_it_should_behave?: string;
      success?: string;
      must_never?: string;
    };
    if (
      typeof parsed.how_it_should_behave === "string" &&
      typeof parsed.success === "string" &&
      typeof parsed.must_never === "string"
    ) {
      return {
        how_it_should_behave: parsed.how_it_should_behave,
        success: parsed.success,
        must_never: parsed.must_never,
      };
    }
  } catch {
    // plain description
  }
  return {
    how_it_should_behave: row.description,
    success: "",
    must_never: "",
  };
}
