import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { copyEvalSetForward } from "../src/eval-set-copy.js";
import { listMembers } from "../src/eval-set.js";
import { generateEvalSuiteOutputSchema } from "../src/tools/schema.js";
import { ErrorCode, isAgentError } from "../src/tools/types.js";
import {
  authHeaders,
  createTestApp,
  seedFiveTrustedEvals,
} from "./helpers/run-fixtures.js";

type GenerateSuccess = {
  project_id: string;
  eval_set_id: string;
  version: number;
  n_draft: number;
  counts: { total: number; trusted: number; draft: number };
};

async function postGenerate(
  app: FastifyInstance,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/v1/tools/generate_eval_suite",
    headers: authHeaders(),
    payload,
  });
}

describe("retire eval (J6)", () => {
  let app: FastifyInstance;
  let dir: string;
  let sqlitePath: string;
  let projectId: string;
  let evalSetId: string;
  let oldEvalIds: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "evalrouter-retire-"));
    sqlitePath = join(dir, "evalrouter.sqlite");
    app = await createTestApp(sqlitePath);

    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: authHeaders(),
      payload: {},
    });
    projectId = (proj.json() as { project_id: string }).project_id;

    const db = new Database(sqlitePath);
    try {
      const seeded = seedFiveTrustedEvals(db, projectId);
      evalSetId = seeded.evalSetId;
      oldEvalIds = seeded.evalIds;
    } finally {
      db.close();
    }
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("copy-forward omitEvalIds drops retired cas_ and keeps marks on remaining", () => {
    const db = new Database(sqlitePath);
    try {
      const retired = oldEvalIds[0]!;
      const kept = oldEvalIds.slice(1);
      const result = copyEvalSetForward(db, {
        projectId,
        sourceEvalSetId: evalSetId,
        omitEvalIds: [retired],
      });
      assert.notEqual(result.newEvalSetId, evalSetId);
      assert.equal(result.previousEvalSetId, evalSetId);
      assert.equal(result.version, 2);
      assert.ok(!result.oldEvalIds.includes(retired));
      assert.deepEqual([...result.oldEvalIds].sort(), [...kept].sort());

      const v1Ids = listMembers(db, evalSetId).map((m) => m.eval_id);
      assert.ok(v1Ids.includes(retired));
      assert.equal(v1Ids.length, oldEvalIds.length);

      const v2Ids = listMembers(db, result.newEvalSetId).map((m) => m.eval_id);
      assert.ok(!v2Ids.includes(retired));
      for (const id of kept) {
        assert.ok(v2Ids.includes(id));
      }
    } finally {
      db.close();
    }
  });

  it("empty omit list is a no-op copy", () => {
    const db = new Database(sqlitePath);
    try {
      const result = copyEvalSetForward(db, {
        projectId,
        sourceEvalSetId: evalSetId,
        omitEvalIds: [],
      });
      assert.deepEqual([...result.oldEvalIds].sort(), [...oldEvalIds].sort());
      const v2Ids = listMembers(db, result.newEvalSetId).map((m) => m.eval_id);
      assert.deepEqual([...v2Ids].sort(), [...oldEvalIds].sort());
    } finally {
      db.close();
    }
  });

  it("Given trusted evals on v1. When retire one cas_. Then new ste_, omitted absent, v1 unchanged", async () => {
    const retired = oldEvalIds[0]!;
    const res = await postGenerate(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      retire_eval_ids: [retired],
      idempotency_key: "retire-one",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.equal(generateEvalSuiteOutputSchema.safeParse(body).success, true);
    assert.notEqual(body.eval_set_id, evalSetId);
    assert.equal(body.version, 2);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const v1 = listMembers(db, evalSetId).map((m) => m.eval_id);
      assert.ok(v1.includes(retired));
      assert.equal(v1.length, oldEvalIds.length);

      const v2 = listMembers(db, body.eval_set_id).map((m) => m.eval_id);
      assert.ok(!v2.includes(retired));
      for (const id of oldEvalIds.slice(1)) {
        assert.ok(v2.includes(id), `old eval ${id} missing from new set`);
      }

      const prev = db
        .prepare(
          "SELECT previous_eval_set_id, version FROM eval_sets WHERE id = ?",
        )
        .get(body.eval_set_id) as {
        previous_eval_set_id: string;
        version: number;
      };
      assert.equal(prev.previous_eval_set_id, evalSetId);
      assert.equal(prev.version, 2);
    } finally {
      db.close();
    }
  });

  it("add_feature plus retire writes new drafts, omits retired, keeps remaining old evals", async () => {
    const retired = oldEvalIds[0]!;
    const res = await postGenerate(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      intent: "add_feature",
      description: "Return JSON with `line_items[]`, `total_cents`, and `currency`.",
      retire_eval_ids: [retired],
      idempotency_key: "add-and-retire",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as GenerateSuccess;
    assert.ok(body.n_draft >= 1);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const v2 = listMembers(db, body.eval_set_id);
      const v2Ids = v2.map((m) => m.eval_id);
      assert.ok(!v2Ids.includes(retired));
      for (const id of oldEvalIds.slice(1)) {
        assert.ok(v2Ids.includes(id));
      }
      assert.ok(v2.some((m) => m.status === "draft"));
      const v1 = listMembers(db, evalSetId).map((m) => m.eval_id);
      assert.ok(v1.includes(retired));
    } finally {
      db.close();
    }
  });

  it("cannot go backwards: v1 still has the retired eval after a new version", async () => {
    const retired = oldEvalIds[0]!;
    const retiredRes = await postGenerate(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      retire_eval_ids: [retired],
      idempotency_key: "retire-freeze-v1",
    });
    assert.equal(retiredRes.statusCode, 200);
    const v2Id = (retiredRes.json() as GenerateSuccess).eval_set_id;

    const fromV1 = await postGenerate(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      intent: "add_feature",
      description: "Return JSON with `line_items[]` and `total_cents`.",
      idempotency_key: "cannot-unretire-v1",
    });
    assert.equal(fromV1.statusCode, 200);
    const fromV1Body = fromV1.json() as GenerateSuccess;
    assert.notEqual(fromV1Body.eval_set_id, evalSetId);
    assert.notEqual(fromV1Body.eval_set_id, v2Id);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const v1 = listMembers(db, evalSetId).map((m) => m.eval_id);
      assert.ok(v1.includes(retired));
      assert.equal(v1.length, oldEvalIds.length);

      const v2 = listMembers(db, v2Id).map((m) => m.eval_id);
      assert.ok(!v2.includes(retired));
    } finally {
      db.close();
    }
  });

  it("unknown retire eval id returns INVALID_INPUT and leaves v1 unchanged", async () => {
    const res = await postGenerate(app, {
      project_id: projectId,
      eval_set_id: evalSetId,
      retire_eval_ids: ["cas_not_in_set"],
      idempotency_key: "retire-unknown",
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500);
    assert.equal(isAgentError(res.json()), true);
    assert.equal((res.json() as { code: string }).code, ErrorCode.INVALID_INPUT);
    assert.ok((res.json() as { next_action: unknown }).next_action);

    const db = new Database(sqlitePath, { readonly: true });
    try {
      const sets = (
        db
          .prepare("SELECT COUNT(*) AS n FROM eval_sets WHERE project_id = ?")
          .get(projectId) as { n: number }
      ).n;
      assert.equal(sets, 1);
      assert.equal(listMembers(db, evalSetId).length, oldEvalIds.length);
    } finally {
      db.close();
    }
  });

  it("same idempotency_key returns the same new ste_", async () => {
    const payload = {
      project_id: projectId,
      eval_set_id: evalSetId,
      retire_eval_ids: [oldEvalIds[0]!],
      idempotency_key: "retire-idem",
    };
    const a = await postGenerate(app, payload);
    const b = await postGenerate(app, payload);
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.equal(
      (a.json() as GenerateSuccess).eval_set_id,
      (b.json() as GenerateSuccess).eval_set_id,
    );
    const db = new Database(sqlitePath, { readonly: true });
    try {
      const n = (
        db
          .prepare("SELECT COUNT(*) AS n FROM eval_sets WHERE project_id = ?")
          .get(projectId) as { n: number }
      ).n;
      assert.equal(n, 2);
    } finally {
      db.close();
    }
  });
});
